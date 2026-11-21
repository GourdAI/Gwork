package e2e

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/router"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// gworkFixture wires an in-memory SQLite database and a gin engine with the
// production /api middleware chain (gzip + access token audit + rate limit),
// so the websocket routes are exercised through exactly the middleware they
// run behind in deployment.
type gworkFixture struct {
	server  *httptest.Server
	db      *gorm.DB
	userIds []int
}

func newGworkFixture(t *testing.T) *gworkFixture {
	t.Helper()
	gin.SetMode(gin.TestMode)

	originalDB, originalLogDB := model.DB, model.LOG_DB
	originalRedis, originalRateLimit := common.RedisEnabled, common.GlobalApiRateLimitEnable
	// Share one in-memory database across pooled connections; a plain
	// ":memory:" DSN would give every pool connection its own empty schema.
	// The unique name isolates fixtures from each other.
	database, err := gorm.Open(sqlite.Open("file:"+strings.ReplaceAll(t.Name(), "/", "_")+"?mode=memory&cache=shared"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, database.AutoMigrate(&model.User{}, &model.UserSession{}, &model.GworkDevice{}, &model.AuditLog{}))
	model.DB = database
	model.LOG_DB = database
	common.RedisEnabled = false
	common.GlobalApiRateLimitEnable = false

	engine := gin.New()
	router.SetApiRouter(engine)
	server := httptest.NewServer(engine)
	fixture := &gworkFixture{server: server, db: database}
	// Cleanup order matters: close the server and drain hijacked websocket
	// handlers before restoring model.DB, or a lingering device read loop
	// would call TouchGworkDeviceLastSeen against a nil DB.
	t.Cleanup(func() {
		server.Close()
		// server.Close waits for hijacked connections to finish, but a device
		// read loop only notices the dropped TCP socket on its next read.
		// Wait for hub cleanup while the DB is still live, then close it.
		deadline := time.Now().Add(5 * time.Second)
		for {
			online := 0
			for _, userId := range fixture.userIds {
				online += len(service.DefaultGworkHub.OnlineDeviceIds(userId))
			}
			if online == 0 {
				break
			}
			require.True(t, time.Now().Before(deadline), "gwork device handlers still online: %d", online)
			time.Sleep(10 * time.Millisecond)
		}
		if sqlDB, err := database.DB(); err == nil {
			_ = sqlDB.Close()
		}
		model.DB, model.LOG_DB = originalDB, originalLogDB
		common.RedisEnabled, common.GlobalApiRateLimitEnable = originalRedis, originalRateLimit
	})
	return fixture
}

// newUser creates an enabled user plus a real login session and returns its
// 15min access token, exercising the same issuance path as controller login.
func (f *gworkFixture) newUser(t *testing.T, username string) (int, string) {
	t.Helper()
	user := model.User{
		Username: username, Password: "unused-password-hash", DisplayName: username,
		Role: common.RoleCommonUser, Status: common.UserStatusEnabled,
		Group: "default", AffCode: "aff-" + username, AuthVersion: 1,
	}
	require.NoError(t, f.db.Create(&user).Error)
	f.userIds = append(f.userIds, user.Id)
	bundle, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "gwork-e2e")
	require.NoError(t, err)
	return user.Id, bundle.AccessToken
}

func (f *gworkFixture) wsURL(path string, params url.Values) string {
	return "ws" + strings.TrimPrefix(f.server.URL, "http") + path + "?" + params.Encode()
}

func (f *gworkFixture) dialDevice(t *testing.T, token, deviceId string) *websocket.Conn {
	t.Helper()
	params := url.Values{"token": {token}, "deviceId": {deviceId}, "name": {"TEST-HOST"}, "platform": {"windows"}, "appVersion": {"1.0.0"}}
	conn, resp, err := websocket.DefaultDialer.Dial(f.wsURL("/api/gwork/device/link", params), nil)
	require.NoError(t, err, "device dial failed")
	_ = resp.Body.Close()
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func (f *gworkFixture) dialMobile(t *testing.T, token, deviceId string) *websocket.Conn {
	t.Helper()
	conn, resp, err := websocket.DefaultDialer.Dial(f.wsURL("/api/gwork/link", url.Values{"token": {token}, "deviceId": {deviceId}}), nil)
	require.NoError(t, err, "mobile dial failed")
	_ = resp.Body.Close()
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// listDevices calls GET /api/gwork/devices with the bearer token and returns
// the decoded data array.
func (f *gworkFixture) listDevices(t *testing.T, token string) []map[string]any {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, f.server.URL+"/api/gwork/devices", nil)
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := f.server.Client().Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode)
	var envelope struct {
		Success bool             `json:"success"`
		Data    []map[string]any `json:"data"`
	}
	require.NoError(t, common.DecodeJson(response.Body, &envelope))
	require.True(t, envelope.Success)
	return envelope.Data
}

func readGworkJSON(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(5*time.Second)))
	_, data, err := conn.ReadMessage()
	require.NoError(t, err)
	var envelope map[string]any
	require.NoError(t, common.Unmarshal(data, &envelope))
	return envelope
}

// waitDeviceOnline polls the devices API until the device shows online. The
// device WS upgrade can complete before the server goroutine finishes its DB
// upsert + hub registration, so this synchronizes without arbitrary sleeps.
func (f *gworkFixture) waitDeviceOnline(t *testing.T, token, deviceId string, online bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		devices := f.listDevices(t, token)
		for _, device := range devices {
			if device["deviceId"] == deviceId && device["online"] == online {
				return
			}
		}
		require.True(t, time.Now().Before(deadline), "device %s never reached online=%v", deviceId, online)
		time.Sleep(10 * time.Millisecond)
	}
}

func TestGworkWsRejectsMissingToken(t *testing.T) {
	f := newGworkFixture(t)
	for _, path := range []string{"/api/gwork/device/link", "/api/gwork/link"} {
		params := url.Values{"deviceId": {"dev-1"}}
		conn, resp, err := websocket.DefaultDialer.Dial(f.wsURL(path, params), nil)
		if conn != nil {
			_ = conn.Close()
		}
		require.Error(t, err, path)
		require.NotNil(t, resp, path)
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode, path)
		var envelope struct {
			Success bool   `json:"success"`
			Code    string `json:"code"`
		}
		require.NoError(t, common.DecodeJson(resp.Body, &envelope))
		_ = resp.Body.Close()
		assert.False(t, envelope.Success)
		assert.NotEmpty(t, envelope.Code)
	}
	// REST route also refuses anonymous callers.
	response, err := f.server.Client().Get(f.server.URL + "/api/gwork/devices")
	require.NoError(t, err)
	defer response.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, response.StatusCode)
}

func TestGworkDeviceLinkLifecycleAndRouting(t *testing.T) {
	f := newGworkFixture(t)
	_, token := f.newUser(t, "gwork-main")
	const deviceId = "dev-link01"

	device := f.dialDevice(t, token, deviceId)
	f.waitDeviceOnline(t, token, deviceId, true)
	devices := f.listDevices(t, token)
	require.Len(t, devices, 1)
	assert.Equal(t, "TEST-HOST", devices[0]["name"])
	assert.Equal(t, "windows", devices[0]["platform"])
	assert.Equal(t, "1.0.0", devices[0]["appVersion"])
	assert.Greater(t, devices[0]["lastSeen"].(float64), float64(0))

	// Deleting an online device is refused with DEVICE_ONLINE.
	request, err := http.NewRequest(http.MethodDelete, f.server.URL+"/api/gwork/devices/"+deviceId, nil)
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := f.server.Client().Do(request)
	require.NoError(t, err)
	var deleteEnvelope struct {
		Success bool   `json:"success"`
		Code    string `json:"code"`
	}
	require.NoError(t, common.DecodeJson(response.Body, &deleteEnvelope))
	_ = response.Body.Close()
	assert.False(t, deleteEnvelope.Success)
	assert.Equal(t, "DEVICE_ONLINE", deleteEnvelope.Code)

	mobile := f.dialMobile(t, token, deviceId)
	ready := readGworkJSON(t, mobile)
	require.Equal(t, "ready", ready["type"])
	assert.Equal(t, deviceId, ready["deviceId"])
	assert.Equal(t, "TEST-HOST", ready["name"])

	// Application-level heartbeat.
	require.NoError(t, mobile.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping"}`)))
	assert.Equal(t, "pong", readGworkJSON(t, mobile)["type"])

	// req -> device (with from/path) -> res -> mobile.
	req := `{"type":"req","reqId":"m-1","method":"GET","path":"/web/chat/sessions","query":"root=","cwd":"","body":"","contentType":"application/json"}`
	require.NoError(t, mobile.WriteMessage(websocket.TextMessage, []byte(req)))
	forwarded := readGworkJSON(t, device)
	require.Equal(t, "req", forwarded["type"])
	assert.Equal(t, "m-1", forwarded["reqId"])
	assert.Equal(t, "/web/chat/sessions", forwarded["path"])
	assert.Equal(t, "GET", forwarded["method"])
	assert.Equal(t, "root=", forwarded["query"])
	from, _ := forwarded["from"].(string)
	require.True(t, strings.HasPrefix(from, "mob-"), "from=%v", forwarded["from"])
	res := `{"type":"res","reqId":"m-1","status":200,"body":"{\"code\":200,\"data\":[]}"}`
	require.NoError(t, device.WriteMessage(websocket.TextMessage, []byte(res)))
	answer := readGworkJSON(t, mobile)
	require.Equal(t, "res", answer["type"])
	assert.Equal(t, "m-1", answer["reqId"])
	assert.Equal(t, float64(200), answer["status"])
	assert.Equal(t, `{"code":200,"data":[]}`, answer["body"])

	// Non-whitelisted path is rejected with a 403 res, never forwarded.
	badReq := `{"type":"req","reqId":"m-bad","method":"GET","path":"/web/admin/exec","query":"","cwd":"","body":"","contentType":"application/json"}`
	require.NoError(t, mobile.WriteMessage(websocket.TextMessage, []byte(badReq)))
	denied := readGworkJSON(t, mobile)
	require.Equal(t, "res", denied["type"])
	assert.Equal(t, "m-bad", denied["reqId"])
	assert.Equal(t, float64(403), denied["status"])

	// Kernel stream frames broadcast verbatim to the mobile connection.
	frame := `{"type":"frame","sessionId":"work-1","payload":{"type":"text","sessionId":"work-1","eventSeq":1,"text":"hello"}}`
	require.NoError(t, device.WriteMessage(websocket.TextMessage, []byte(frame)))
	received := readGworkJSON(t, mobile)
	require.Equal(t, "frame", received["type"])
	assert.Equal(t, "work-1", received["sessionId"])
	payload, _ := received["payload"].(map[string]any)
	require.NotNil(t, payload)
	assert.Equal(t, "hello", payload["text"])

	// Device disconnect: device_offline notice, close code 4001, offline list.
	require.NoError(t, device.Close())
	notice := readGworkJSON(t, mobile)
	require.Equal(t, "device_offline", notice["type"])
	assert.Equal(t, deviceId, notice["deviceId"])
	require.NoError(t, mobile.SetReadDeadline(time.Now().Add(5*time.Second)))
	_, _, err = mobile.ReadMessage()
	var closeErr *websocket.CloseError
	require.ErrorAs(t, err, &closeErr)
	assert.Equal(t, 4001, closeErr.Code)
	f.waitDeviceOnline(t, token, deviceId, false)

	// Offline device row can now be deleted.
	request, err = http.NewRequest(http.MethodDelete, f.server.URL+"/api/gwork/devices/"+deviceId, nil)
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err = f.server.Client().Do(request)
	require.NoError(t, err)
	var deleted struct {
		Success bool `json:"success"`
	}
	require.NoError(t, common.DecodeJson(response.Body, &deleted))
	_ = response.Body.Close()
	assert.True(t, deleted.Success)
	assert.Empty(t, f.listDevices(t, token))
}

func TestGworkCrossUserIsolation(t *testing.T) {
	f := newGworkFixture(t)
	_, tokenA := f.newUser(t, "gwork-user-a")
	_, tokenB := f.newUser(t, "gwork-user-b")
	const deviceId = "dev-iso001"

	deviceA := f.dialDevice(t, tokenA, deviceId)
	f.waitDeviceOnline(t, tokenA, deviceId, true)

	// User B cannot attach a mobile connection to user A's device.
	params := url.Values{"token": {tokenB}, "deviceId": {deviceId}}
	conn, resp, err := websocket.DefaultDialer.Dial(f.wsURL("/api/gwork/link", params), nil)
	if conn != nil {
		_ = conn.Close()
	}
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	var envelope struct {
		Success bool   `json:"success"`
		Code    string `json:"code"`
	}
	require.NoError(t, common.DecodeJson(resp.Body, &envelope))
	_ = resp.Body.Close()
	assert.False(t, envelope.Success)
	assert.Equal(t, "DEVICE_OFFLINE", envelope.Code)

	// User B's device list never shows user A's device.
	assert.Empty(t, f.listDevices(t, tokenB))

	// Same deviceId under a different account is a separate device: B may
	// register it, and that must not disturb A's connection or routing.
	deviceB := f.dialDevice(t, tokenB, deviceId)
	f.waitDeviceOnline(t, tokenB, deviceId, true)
	mobileA := f.dialMobile(t, tokenA, deviceId)
	require.Equal(t, "ready", readGworkJSON(t, mobileA)["type"])
	mobileB := f.dialMobile(t, tokenB, deviceId)
	require.Equal(t, "ready", readGworkJSON(t, mobileB)["type"])

	// Same reqId on both accounts; each request must reach only its own
	// account's device and each response only its own account's mobile.
	req := `{"type":"req","reqId":"iso-1","method":"GET","path":"/web/chat/meta","query":"","cwd":"","body":"","contentType":"application/json"}`
	require.NoError(t, mobileA.WriteMessage(websocket.TextMessage, []byte(req)))
	require.NoError(t, mobileB.WriteMessage(websocket.TextMessage, []byte(req)))
	assert.Equal(t, "iso-1", readGworkJSON(t, deviceA)["reqId"])
	assert.Equal(t, "iso-1", readGworkJSON(t, deviceB)["reqId"])
	require.NoError(t, deviceA.WriteMessage(websocket.TextMessage, []byte(`{"type":"res","reqId":"iso-1","status":200,"body":"account-A"}`)))
	require.NoError(t, deviceB.WriteMessage(websocket.TextMessage, []byte(`{"type":"res","reqId":"iso-1","status":200,"body":"account-B"}`)))
	assert.Equal(t, "account-A", readGworkJSON(t, mobileA)["body"])
	assert.Equal(t, "account-B", readGworkJSON(t, mobileB)["body"])

	// A frame from B's device must never reach A's mobile: after B broadcasts,
	// B's mobile receives it while A's next read only sees its own traffic.
	require.NoError(t, deviceB.WriteMessage(websocket.TextMessage, []byte(`{"type":"frame","sessionId":"work-b","payload":{"type":"text","text":"B-only"}}`)))
	frameB := readGworkJSON(t, mobileB)
	require.Equal(t, "frame", frameB["type"])
	assert.Equal(t, "work-b", frameB["sessionId"])
	require.NoError(t, deviceA.WriteMessage(websocket.TextMessage, []byte(`{"type":"frame","sessionId":"work-a","payload":{"type":"text","text":"A-only"}}`)))
	frameA := readGworkJSON(t, mobileA)
	require.Equal(t, "frame", frameA["type"])
	assert.Equal(t, "work-a", frameA["sessionId"])
}

func TestGworkMobileOfflineDeviceRejected(t *testing.T) {
	f := newGworkFixture(t)
	_, token := f.newUser(t, "gwork-offline")
	// Unknown device.
	params := url.Values{"token": {token}, "deviceId": {"dev-none01"}}
	conn, resp, err := websocket.DefaultDialer.Dial(f.wsURL("/api/gwork/link", params), nil)
	if conn != nil {
		_ = conn.Close()
	}
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	var envelope struct {
		Code string `json:"code"`
	}
	require.NoError(t, common.DecodeJson(resp.Body, &envelope))
	_ = resp.Body.Close()
	assert.Equal(t, "DEVICE_OFFLINE", envelope.Code)

	// Known but offline device row.
	var user model.User
	require.NoError(t, f.db.Where("username = ?", "gwork-offline").First(&user).Error)
	require.NoError(t, model.UpsertGworkDevice(user.Id, "dev-known1", "OFF-HOST", "linux", "0.9"))
	params.Set("deviceId", "dev-known1")
	conn, resp, err = websocket.DefaultDialer.Dial(f.wsURL("/api/gwork/link", params), nil)
	if conn != nil {
		_ = conn.Close()
	}
	require.Error(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	_ = resp.Body.Close()
	devices := f.listDevices(t, token)
	require.Len(t, devices, 1)
	assert.Equal(t, false, devices[0]["online"])
	assert.Equal(t, "dev-known1", devices[0]["deviceId"])
}

func TestGworkAccessTokenRoutesAreSessionOnly(t *testing.T) {
	for _, key := range []string{
		"GET /api/gwork/devices",
		"DELETE /api/gwork/devices/:deviceId",
		"GET /api/gwork/device/link",
		"GET /api/gwork/link",
	} {
		rule, declared := middleware.AccessTokenRouteRule(key)
		require.True(t, declared, key)
		assert.Equal(t, "session", rule.Kind(), key)
	}
}
