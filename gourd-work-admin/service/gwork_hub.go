package service

import (
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

// GworkHub is the single-process connection registry for the GWork device
// relay (PROTOCOL.md v1). Routing keys are always (userID, deviceId): a frame
// can never cross accounts. Every outbound write is non-blocking; a connection
// whose send buffer is full is considered dead and closed instead of stalling
// the caller's read loop.

const (
	// gworkSendBuffer bounds each connection's outbound queue.
	gworkSendBuffer = 256
	// GworkReqTimeout is the backend-side request deadline (protocol §3.1: 35s).
	GworkReqTimeout = 35 * time.Second
	// GworkCloseDeviceOffline is the WS close code sent to mobile connections
	// when their device goes away (protocol §3.3).
	GworkCloseDeviceOffline = 4001
)

// GworkLinkConn is one live websocket (device or mobile). The controller's
// write pump drains Outbound and watches Done; the hub only queues payloads
// and requests shutdown through Close. All operations are non-blocking.
type GworkLinkConn struct {
	send        chan []byte
	done        chan struct{}
	closeOnce   sync.Once
	closeCode   int
	closeReason string
	lastSeenMu  sync.Mutex
	lastSeen    int64
}

func NewGworkLinkConn() *GworkLinkConn {
	return &GworkLinkConn{
		send:     make(chan []byte, gworkSendBuffer),
		done:     make(chan struct{}),
		lastSeen: time.Now().UnixMilli(),
	}
}

// Outbound is the buffered payload queue consumed by the write pump.
func (conn *GworkLinkConn) Outbound() <-chan []byte { return conn.send }

// Done fires once when the connection is shutting down; CloseCode and
// CloseReason are stable after it fires.
func (conn *GworkLinkConn) Done() <-chan struct{} { return conn.done }

func (conn *GworkLinkConn) CloseCode() int      { return conn.closeCode }
func (conn *GworkLinkConn) CloseReason() string { return conn.closeReason }

// Send queues one text payload. Returns false and closes the connection when
// the buffer is full: a stuck peer must never block the caller's read loop.
func (conn *GworkLinkConn) Send(payload []byte) bool {
	select {
	case conn.send <- payload:
		return true
	default:
		conn.Close(1011, "send buffer overflow")
		return false
	}
}

// Close requests the controller-side shutdown exactly once.
func (conn *GworkLinkConn) Close(code int, reason string) {
	conn.closeOnce.Do(func() {
		conn.closeCode = code
		conn.closeReason = reason
		close(conn.done)
	})
}

// Touch records inbound activity; the controller persists device last_seen on
// disconnect only, keeping the hot path free of database writes.
func (conn *GworkLinkConn) Touch() {
	conn.lastSeenMu.Lock()
	conn.lastSeen = time.Now().UnixMilli()
	conn.lastSeenMu.Unlock()
}

func (conn *GworkLinkConn) LastSeen() int64 {
	conn.lastSeenMu.Lock()
	defer conn.lastSeenMu.Unlock()
	return conn.lastSeen
}

// gworkPendingReq maps an in-flight reqId to the mobile connection awaiting
// the response, with a timer that answers 502 when the device never replies.
type gworkPendingReq struct {
	mobile *GworkLinkConn
	reqId  string
	timer  *time.Timer
}

type GworkHub struct {
	mu      sync.Mutex
	devices map[int]map[string]*GworkLinkConn            // userId -> deviceId -> device conn
	mobiles map[int]map[string]map[string]*GworkLinkConn // userId -> deviceId -> mobileId -> conn
	pending map[int]map[string]map[string]*gworkPendingReq
}

var DefaultGworkHub = NewGworkHub()

func NewGworkHub() *GworkHub {
	return &GworkHub{
		devices: map[int]map[string]*GworkLinkConn{},
		mobiles: map[int]map[string]map[string]*GworkLinkConn{},
		pending: map[int]map[string]map[string]*gworkPendingReq{},
	}
}

// RegisterDevice marks the device online. A reconnect with the same deviceId
// kicks the previous connection (close 4000) and its mobile connections.
func (hub *GworkHub) RegisterDevice(userId int, deviceId string, conn *GworkLinkConn) {
	hub.mu.Lock()
	byDevice := hub.devices[userId]
	if byDevice == nil {
		byDevice = map[string]*GworkLinkConn{}
		hub.devices[userId] = byDevice
	}
	old := byDevice[deviceId]
	byDevice[deviceId] = conn
	hub.mu.Unlock()
	if old != nil {
		old.Close(4000, "replaced by a new connection")
	}
}

// UnregisterDevice marks the device offline, persists last_seen, fails all
// pending requests with 502 and closes every attached mobile connection with
// 4001 after a device_offline notice (protocol §3.3). It is a no-op when conn
// is no longer the registered one (a kicked old connection cleaning up).
func (hub *GworkHub) UnregisterDevice(userId int, deviceId string, conn *GworkLinkConn) {
	hub.mu.Lock()
	if hub.devices[userId][deviceId] != conn {
		hub.mu.Unlock()
		return
	}
	delete(hub.devices[userId], deviceId)
	if len(hub.devices[userId]) == 0 {
		delete(hub.devices, userId)
	}
	mobiles := hub.mobiles[userId][deviceId]
	delete(hub.mobiles[userId], deviceId)
	if len(hub.mobiles[userId]) == 0 {
		delete(hub.mobiles, userId)
	}
	pending := hub.pending[userId][deviceId]
	delete(hub.pending[userId], deviceId)
	if len(hub.pending[userId]) == 0 {
		delete(hub.pending, userId)
	}
	hub.mu.Unlock()

	if err := model.TouchGworkDeviceLastSeen(userId, deviceId); err != nil {
		common.SysError(common.LogText("gwork: failed to update device last_seen (user=%d device=%s): %v", userId, deviceId, err))
	}
	offlineNotice, _ := common.Marshal(map[string]any{"type": "device_offline", "deviceId": deviceId})
	for _, mobile := range mobiles {
		mobile.Send(offlineNotice)
		mobile.Close(GworkCloseDeviceOffline, "device offline")
	}
	for _, entry := range pending {
		entry.timer.Stop()
		gworkReplyUnavailable(entry.mobile, entry.reqId)
	}
}

func (hub *GworkHub) IsDeviceOnline(userId int, deviceId string) bool {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	return hub.devices[userId][deviceId] != nil
}

// OnlineDeviceIds lists the account's devices with a live device websocket.
func (hub *GworkHub) OnlineDeviceIds(userId int) []string {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	ids := make([]string, 0, len(hub.devices[userId]))
	for deviceId := range hub.devices[userId] {
		ids = append(ids, deviceId)
	}
	return ids
}

// RegisterMobile attaches a mobile connection to an online device. It fails
// when the device went offline between the upgrade check and registration.
func (hub *GworkHub) RegisterMobile(userId int, deviceId, mobileId string, conn *GworkLinkConn) bool {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.devices[userId][deviceId] == nil {
		return false
	}
	byDevice := hub.mobiles[userId]
	if byDevice == nil {
		byDevice = map[string]map[string]*GworkLinkConn{}
		hub.mobiles[userId] = byDevice
	}
	byMobile := byDevice[deviceId]
	if byMobile == nil {
		byMobile = map[string]*GworkLinkConn{}
		byDevice[deviceId] = byMobile
	}
	byMobile[mobileId] = conn
	return true
}

func (hub *GworkHub) UnregisterMobile(userId int, deviceId, mobileId string, conn *GworkLinkConn) {
	hub.mu.Lock()
	if hub.mobiles[userId][deviceId][mobileId] != conn {
		hub.mu.Unlock()
		return
	}
	delete(hub.mobiles[userId][deviceId], mobileId)
	if len(hub.mobiles[userId][deviceId]) == 0 {
		delete(hub.mobiles[userId], deviceId)
	}
	if len(hub.mobiles[userId]) == 0 {
		delete(hub.mobiles, userId)
	}
	// The mobile peer is gone: drop its pending requests, nothing to deliver.
	for reqId, entry := range hub.pending[userId][deviceId] {
		if entry.mobile == conn {
			entry.timer.Stop()
			delete(hub.pending[userId][deviceId], reqId)
		}
	}
	if len(hub.pending[userId][deviceId]) == 0 {
		delete(hub.pending[userId], deviceId)
	}
	if len(hub.pending[userId]) == 0 {
		delete(hub.pending, userId)
	}
	hub.mu.Unlock()
}

// RouteReq forwards a mobile request envelope to the device and registers the
// reqId -> mobile mapping with a 35s timeout. Returns false when the device is
// not online; the caller answers 502 itself in that case.
func (hub *GworkHub) RouteReq(userId int, deviceId, mobileId string, mobile *GworkLinkConn, reqId string, envelope []byte) bool {
	hub.mu.Lock()
	device := hub.devices[userId][deviceId]
	if device == nil {
		hub.mu.Unlock()
		return false
	}
	byDevice := hub.pending[userId]
	if byDevice == nil {
		byDevice = map[string]map[string]*gworkPendingReq{}
		hub.pending[userId] = byDevice
	}
	byReq := byDevice[deviceId]
	if byReq == nil {
		byReq = map[string]*gworkPendingReq{}
		byDevice[deviceId] = byReq
	}
	if old := byReq[reqId]; old != nil {
		old.timer.Stop()
	}
	entry := &gworkPendingReq{mobile: mobile, reqId: reqId}
	entry.timer = time.AfterFunc(GworkReqTimeout, func() {
		hub.mu.Lock()
		current := hub.pending[userId][deviceId][reqId]
		if current == entry {
			delete(hub.pending[userId][deviceId], reqId)
		}
		hub.mu.Unlock()
		if current == entry {
			gworkReplyUnavailable(mobile, reqId)
		}
	})
	byReq[reqId] = entry
	hub.mu.Unlock()
	if !device.Send(envelope) {
		// Dead device connection: drop the pending entry; its read loop will
		// run UnregisterDevice and fail the rest.
		hub.mu.Lock()
		if hub.pending[userId][deviceId][reqId] == entry {
			entry.timer.Stop()
			delete(hub.pending[userId][deviceId], reqId)
		}
		hub.mu.Unlock()
		return false
	}
	return true
}

// RouteRes delivers a device response to the mobile connection that issued
// the reqId and clears the pending entry. Unknown reqIds are dropped.
func (hub *GworkHub) RouteRes(userId int, deviceId, reqId string, envelope []byte) {
	hub.mu.Lock()
	entry := hub.pending[userId][deviceId][reqId]
	if entry != nil {
		entry.timer.Stop()
		delete(hub.pending[userId][deviceId], reqId)
		if len(hub.pending[userId][deviceId]) == 0 {
			delete(hub.pending[userId], deviceId)
		}
		if len(hub.pending[userId]) == 0 {
			delete(hub.pending, userId)
		}
	}
	hub.mu.Unlock()
	if entry != nil {
		entry.mobile.Send(envelope)
	}
}

// BroadcastFrame forwards one kernel stream frame to every mobile connection
// attached to the device (protocol §3.2).
func (hub *GworkHub) BroadcastFrame(userId int, deviceId string, envelope []byte) {
	hub.mu.Lock()
	mobiles := make([]*GworkLinkConn, 0, len(hub.mobiles[userId][deviceId]))
	for _, mobile := range hub.mobiles[userId][deviceId] {
		mobiles = append(mobiles, mobile)
	}
	hub.mu.Unlock()
	for _, mobile := range mobiles {
		mobile.Send(envelope)
	}
}

// GworkDeviceOfflineRes builds the protocol §3.1 offline/timeout response.
func GworkDeviceOfflineRes(reqId string) []byte {
	body, _ := common.Marshal(map[string]any{"code": 502, "description": "device offline"})
	envelope, _ := common.Marshal(map[string]any{"type": "res", "reqId": reqId, "status": 502, "body": string(body)})
	return envelope
}

// gworkReplyUnavailable delivers the offline/timeout response to one mobile.
func gworkReplyUnavailable(mobile *GworkLinkConn, reqId string) {
	mobile.Send(GworkDeviceOfflineRes(reqId))
}
