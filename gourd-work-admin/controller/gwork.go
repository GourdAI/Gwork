package controller

import (
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// GWork device relay (see .gwork/mobile-link/PROTOCOL.md v1). REST endpoints
// sit behind middleware.UserAuth; both websocket endpoints authenticate the
// query access token before upgrading, because H5 clients cannot set headers.

const (
	gworkReadTimeout  = 60 * time.Second // §2.4: no frame for 60s means dead
	gworkPingInterval = 25 * time.Second // §2.4: protocol-level ping every 25s
	gworkWriteTimeout = 10 * time.Second
	gworkMaxFrameSize = 4 << 20
)

// gworkPathWhitelist is the exact-match kernel path allowlist of protocol
// §2.1. Query strings are carried separately and never part of the match.
var gworkPathWhitelist = []string{
	"/web/chat/meta",
	"/web/chat/sessions",
	"/web/chat/messages",
	"/web/chat/replay",
	"/web/chat/input",
	"/web/chat/interrupt",
	"/web/chat/models",
	"/web/chat/models/select",
	"/web/chat/thinking/select",
	"/web/chat/context/select",
	"/web/chat/access/select",
	"/web/chat/todos",
	"/web/chat/pendingQuestion",
	"/web/chat/sessions/delete",
	"/web/chat/sessions/rename",
	"/web/chat/projects",
}

var gworkUpgrader = websocket.Upgrader{
	HandshakeTimeout: 15 * time.Second,
	CheckOrigin:      func(r *http.Request) bool { return true }, // same precedent as controller/relay.go
}

type gworkDeviceView struct {
	DeviceId   string `json:"deviceId"`
	Name       string `json:"name"`
	Platform   string `json:"platform"`
	Online     bool   `json:"online"`
	LastSeen   int64  `json:"lastSeen"`
	AppVersion string `json:"appVersion"`
}

func GetGworkDevices(c *gin.Context) {
	userId := c.GetInt("id")
	devices, err := model.ListGworkDevices(userId)
	if err != nil {
		common.SysError(common.LogText("gwork: failed to list devices (user=%d): %v", userId, err))
		common.ApiErrorMsg(c, "failed to list devices")
		return
	}
	views := make([]gworkDeviceView, 0, len(devices))
	for _, device := range devices {
		views = append(views, gworkDeviceView{
			DeviceId:   device.DeviceId,
			Name:       device.Name,
			Platform:   device.Platform,
			Online:     service.DefaultGworkHub.IsDeviceOnline(userId, device.DeviceId),
			LastSeen:   device.LastSeen,
			AppVersion: device.AppVersion,
		})
	}
	common.ApiSuccess(c, views)
}

func DeleteGworkDevice(c *gin.Context) {
	userId := c.GetInt("id")
	deviceId := c.Param("deviceId")
	if !validGworkDeviceId(deviceId) {
		common.ApiErrorMsg(c, "invalid deviceId")
		return
	}
	if service.DefaultGworkHub.IsDeviceOnline(userId, deviceId) {
		common.ApiErrorStatus(c, http.StatusOK, common.NewMessage("The device is online; disconnect it before deleting"), gin.H{"code": "DEVICE_ONLINE"})
		return
	}
	if err := model.DeleteGworkDevice(userId, deviceId); err != nil {
		common.SysError(common.LogText("gwork: failed to delete device (user=%d device=%s): %v", userId, deviceId, err))
		common.ApiErrorMsg(c, "failed to delete device")
		return
	}
	common.ApiSuccess(c, nil)
}

// validGworkDeviceId enforces the protocol deviceId shape: 1..64 chars of
// [a-zA-Z0-9-_].
func validGworkDeviceId(deviceId string) bool {
	if deviceId == "" || len(deviceId) > 64 {
		return false
	}
	for _, r := range deviceId {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

// authenticateGworkWs validates the query access token exactly like the
// dashboard middleware (ParseDashboardAccessToken + ValidateLoginSession).
// Only internal session JWTs are accepted; PATs and relay keys are refused.
// On failure it has already written the 401 JSON envelope.
func authenticateGworkWs(c *gin.Context) (int, bool) {
	raw := strings.TrimSpace(c.Query("token"))
	identity, internal, err := service.ParseDashboardAccessToken(raw)
	if !internal || err != nil {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Unauthorized, invalid access token"), gin.H{"code": "AUTH_UNAUTHORIZED"})
		return 0, false
	}
	if _, _, err := service.ValidateLoginSession(identity); err != nil {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Unauthorized, not logged in and no access token provided"), gin.H{"code": "AUTH_SESSION_REVOKED"})
		return 0, false
	}
	return identity.UserID, true
}

// gworkWritePump is the sole writer goroutine of one websocket: queued text
// frames plus a 25s protocol-level ping, honoring gorilla's single-writer
// rule. When conn is closed (hub kick, device offline, buffer overflow) it
// flushes what is already queued, sends the requested close frame and closes
// the socket, which unblocks the read loop.
func gworkWritePump(ws *websocket.Conn, conn *service.GworkLinkConn) {
	ticker := time.NewTicker(gworkPingInterval)
	defer ticker.Stop()
	defer ws.Close()
	writeText := func(payload []byte) bool {
		_ = ws.SetWriteDeadline(time.Now().Add(gworkWriteTimeout))
		return ws.WriteMessage(websocket.TextMessage, payload) == nil
	}
	for {
		select {
		case payload := <-conn.Outbound():
			if !writeText(payload) {
				return
			}
		case <-ticker.C:
			_ = ws.SetWriteDeadline(time.Now().Add(gworkWriteTimeout))
			if err := ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-conn.Done():
			// Give queued payloads (e.g. the device_offline notice sent right
			// before Close) a brief drain window so they precede the close
			// frame. The window only bounds idle waiting: as long as payloads
			// keep flowing we keep writing; a stuck peer is cut off by the
			// write deadline anyway.
			drainIdle := time.NewTimer(200 * time.Millisecond)
			defer drainIdle.Stop()
			for {
				select {
				case payload := <-conn.Outbound():
					if !writeText(payload) {
						return
					}
				case <-drainIdle.C:
					_ = ws.SetWriteDeadline(time.Now().Add(gworkWriteTimeout))
					_ = ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(conn.CloseCode(), conn.CloseReason()))
					return
				}
			}
		}
	}
}

// armGworkReadSide installs the 60s idle deadline, refreshed on any inbound
// frame, and answers protocol-level pings with a pong control frame.
func armGworkReadSide(ws *websocket.Conn, conn *service.GworkLinkConn) {
	ws.SetReadLimit(gworkMaxFrameSize)
	_ = ws.SetReadDeadline(time.Now().Add(gworkReadTimeout))
	ws.SetPongHandler(func(string) error {
		conn.Touch()
		return ws.SetReadDeadline(time.Now().Add(gworkReadTimeout))
	})
	ws.SetPingHandler(func(data string) error {
		conn.Touch()
		_ = ws.SetReadDeadline(time.Now().Add(gworkReadTimeout))
		return ws.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(gworkWriteTimeout))
	})
}

func GworkDeviceLink(c *gin.Context) {
	userId, ok := authenticateGworkWs(c)
	if !ok {
		return
	}
	deviceId := c.Query("deviceId")
	if !validGworkDeviceId(deviceId) {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Invalid deviceId"), gin.H{"code": "INVALID_DEVICE_ID"})
		return
	}
	name := truncateGworkMeta(c.Query("name"), 128)
	platform := truncateGworkMeta(c.Query("platform"), 16)
	appVersion := truncateGworkMeta(c.Query("appVersion"), 64)

	ws, err := gworkUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return // Upgrade already answered the handshake failure
	}
	if err := model.UpsertGworkDevice(userId, deviceId, name, platform, appVersion); err != nil {
		common.SysError(common.LogText("gwork: failed to upsert device (user=%d device=%s): %v", userId, deviceId, err))
		_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1011, "database error"), time.Now().Add(gworkWriteTimeout))
		_ = ws.Close()
		return
	}

	conn := service.NewGworkLinkConn()
	hub := service.DefaultGworkHub
	hub.RegisterDevice(userId, deviceId, conn)
	defer hub.UnregisterDevice(userId, deviceId, conn)
	defer conn.Close(websocket.CloseNormalClosure, "")
	go gworkWritePump(ws, conn)
	armGworkReadSide(ws, conn)

	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		conn.Touch()
		_ = ws.SetReadDeadline(time.Now().Add(gworkReadTimeout))
		var envelope map[string]any
		if common.Unmarshal(data, &envelope) != nil {
			continue
		}
		switch envelope["type"] {
		case "ping":
			conn.Send([]byte(`{"type":"pong"}`))
		case "res":
			reqId, _ := envelope["reqId"].(string)
			if reqId != "" {
				hub.RouteRes(userId, deviceId, reqId, data)
			}
		case "frame":
			hub.BroadcastFrame(userId, deviceId, data)
		default:
			// Unknown device frames are dropped: the backend is a router,
			// not a business peer (protocol §0).
		}
	}
}

func GworkLink(c *gin.Context) {
	userId, ok := authenticateGworkWs(c)
	if !ok {
		return
	}
	deviceId := c.Query("deviceId")
	if !validGworkDeviceId(deviceId) {
		common.ApiErrorStatus(c, http.StatusNotFound, common.NewMessage("Device not found"), gin.H{"code": "DEVICE_OFFLINE"})
		return
	}
	device, err := model.GetGworkDevice(userId, deviceId)
	if err != nil {
		common.SysError(common.LogText("gwork: failed to load device (user=%d device=%s): %v", userId, deviceId, err))
		common.ApiErrorMsg(c, "failed to load device")
		return
	}
	hub := service.DefaultGworkHub
	if device == nil || !hub.IsDeviceOnline(userId, deviceId) {
		common.ApiErrorStatus(c, http.StatusNotFound, common.NewMessage("Device is offline"), gin.H{"code": "DEVICE_OFFLINE"})
		return
	}

	ws, err := gworkUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	mobileId := "mob-" + uuid.NewString()[:8]
	conn := service.NewGworkLinkConn()
	if !hub.RegisterMobile(userId, deviceId, mobileId, conn) {
		_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(service.GworkCloseDeviceOffline, "device offline"), time.Now().Add(gworkWriteTimeout))
		_ = ws.Close()
		return
	}
	defer hub.UnregisterMobile(userId, deviceId, mobileId, conn)
	defer conn.Close(websocket.CloseNormalClosure, "")
	go gworkWritePump(ws, conn)
	armGworkReadSide(ws, conn)

	ready, _ := common.Marshal(map[string]any{"type": "ready", "deviceId": deviceId, "name": device.Name})
	conn.Send(ready)

	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		conn.Touch()
		_ = ws.SetReadDeadline(time.Now().Add(gworkReadTimeout))
		var envelope map[string]any
		if common.Unmarshal(data, &envelope) != nil {
			continue
		}
		switch envelope["type"] {
		case "ping":
			conn.Send([]byte(`{"type":"pong"}`))
		case "req":
			reqId, _ := envelope["reqId"].(string)
			if reqId == "" {
				continue
			}
			path, _ := envelope["path"].(string)
			if !slices.Contains(gworkPathWhitelist, path) {
				body, _ := common.Marshal(map[string]any{"code": 403, "description": "path not allowed"})
				res, _ := common.Marshal(map[string]any{"type": "res", "reqId": reqId, "status": 403, "body": string(body)})
				conn.Send(res)
				continue
			}
			envelope["from"] = mobileId
			forwarded, err := common.Marshal(envelope)
			if err != nil {
				continue
			}
			if !hub.RouteReq(userId, deviceId, mobileId, conn, reqId, forwarded) {
				conn.Send(service.GworkDeviceOfflineRes(reqId))
			}
		default:
			// Mobile connections may only send req/ping (protocol §3.1).
		}
	}
}

func truncateGworkMeta(value string, maxLen int) string {
	value = strings.TrimSpace(value)
	if len(value) <= maxLen {
		return value
	}
	// Cut on a rune boundary: a raw byte slice can split a multi-byte UTF-8
	// character (e.g. a Chinese device name), storing invalid UTF-8 in the DB.
	value = value[:maxLen]
	for len(value) > 0 && !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}
