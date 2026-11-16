package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestEnsureUserModelKeyCreatesOrdinaryToken(t *testing.T) {
	setupTokenControllerTestDB(t)
	require.NoError(t, i18n.Init())
	previous := setting.DefaultUseAutoGroup
	setting.DefaultUseAutoGroup = false
	t.Cleanup(func() { setting.DefaultUseAutoGroup = previous })

	key, err := ensureUserModelKey(101, "model-key-user")
	require.NoError(t, err)
	assert.Len(t, key, 48)
	assert.False(t, strings.HasPrefix(key, "sk-"))
	assert.Equal(t, key, mustFindUserModelKey(t, 101))

	var token model.Token
	require.NoError(t, model.DB.Where("user_id = ?", 101).First(&token).Error)
	assert.Equal(t, key, token.GetFullKey())
	assert.Equal(t, common.TokenStatusEnabled, token.Status)
	assert.EqualValues(t, -1, token.ExpiredTime)
	assert.Equal(t, 500000, token.RemainQuota)
	assert.True(t, token.UnlimitedQuota)
	assert.True(t, token.AllowUserQuotaQuery)
	assert.False(t, token.ModelLimitsEnabled)
	assert.NotEmpty(t, token.CreatedTime)
	assert.NotEmpty(t, token.AccessedTime)
	assert.Equal(t, i18n.Translate(common.DefaultLanguage, i18n.MsgUserDefaultTokenName, map[string]any{"Username": "model-key-user"}), token.Name)
}

func TestEnsureUserModelKeyReusesExistingAndIsIdempotent(t *testing.T) {
	db := setupTokenControllerTestDB(t)
	// seedToken (shared with token_test.go) does not state its relay-relevant
	// fields explicitly, so use a local seed that is unambiguously qualified.
	seedQualifiedModelKeyToken(t, db, 201, "existing", "existing-enabled-key")

	key, err := ensureUserModelKey(201, "model-key-user")
	require.NoError(t, err)
	assert.Equal(t, "existing-enabled-key", key)
	assert.EqualValues(t, 1, countUserModelTokens(t, db, 201))

	for i := 0; i < 3; i++ {
		again, err := ensureUserModelKey(201, "model-key-user")
		require.NoError(t, err)
		assert.Equal(t, key, again)
	}
	assert.EqualValues(t, 1, countUserModelTokens(t, db, 201))

	require.NoError(t, db.Create(&model.Token{
		UserId: 201, Name: "disabled", Key: "disabled-key", Status: common.TokenStatusDisabled,
		ExpiredTime: -1, UnlimitedQuota: true,
	}).Error)
	key, err = ensureUserModelKey(202, "other-user")
	require.NoError(t, err)
	assert.NotEqual(t, "disabled-key", key)
	assert.Len(t, key, 48)
	assert.EqualValues(t, 1, countUserModelTokens(t, db, 202))
	assert.Equal(t, key, mustFindUserModelKey(t, 202))
	assert.EqualValues(t, 2, countUserModelTokens(t, db, 201))
}

// TestEnsureUserModelKeyRejectsRelayBlockedTokens covers every persisted field
// UpdateToken can change that makes ValidateUserToken / TokenAuth / Distribute
// reject the key: expiry, exhausted quota, model limits, IP whitelist.
// Each case starts from a fresh user, so the first (and only) enabled token is
// the blocked one; ensureUserModelKey must skip it and create a qualified key.
//
// A finite-but-funded token is NOT in this list: relay only needs the token to
// pass ValidateUserToken (model/token.go:245 rejects `!UnlimitedQuota &&
// RemainQuota <= 0`), and the user-level billing gate is enforced separately in
// service/billing_session.go. See
// TestEnsureUserModelKeyReusesFiniteQuotaPaidToken.
func TestEnsureUserModelKeyRejectsRelayBlockedTokens(t *testing.T) {
	db := setupTokenControllerTestDB(t)
	allowIPs := "203.0.113.57"
	cases := []struct {
		name   string
		userID int
		mutate func(*model.Token)
	}{
		{"expired", 211, func(tk *model.Token) { tk.ExpiredTime = common.GetTimestamp() - 60 }},
		{"exhausted quota", 213, func(tk *model.Token) {
			tk.UnlimitedQuota = false
			tk.RemainQuota = 0
		}},
		{"model limits", 214, func(tk *model.Token) {
			tk.ModelLimitsEnabled = true
			tk.ModelLimits = "gpt-4o"
		}},
		{"allow ips", 215, func(tk *model.Token) { tk.AllowIps = &allowIPs }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tk := seedQualifiedModelKeyToken(t, db, tc.userID, "blocked", "blocked-key-"+tc.name)
			tc.mutate(tk)
			require.NoError(t, db.Save(tk).Error)

			key, err := ensureUserModelKey(tc.userID, "blocked-user")
			require.NoError(t, err)
			assert.Len(t, key, 48)
			assert.NotEqual(t, tk.GetFullKey(), key)
			assert.EqualValues(t, 2, countUserModelTokens(t, db, tc.userID))

			var created model.Token
			require.NoError(t, db.Where("user_id = ?", tc.userID).Order("id desc").First(&created).Error)
			assert.Equal(t, key, created.GetFullKey())
			assert.Equal(t, common.TokenStatusEnabled, created.Status)
			assert.EqualValues(t, -1, created.ExpiredTime)
			assert.True(t, created.UnlimitedQuota)
			assert.False(t, created.ModelLimitsEnabled)
			assert.True(t, created.AllowIps == nil || *created.AllowIps == "")
			assert.Equal(t, key, mustFindUserModelKey(t, tc.userID))
		})
	}
}

// TestEnsureUserModelKeyReusesFiniteQuotaPaidToken pins the billing contract the
// user asked for: "the key is the user's own, and it bills through the user's
// existing scheme."
//
// An earlier version required `unlimited_quota = true` to treat a token as
// qualified. That silently skipped the paid token the user had created with its
// own remaining quota and minted a brand new unlimited one instead — polluting
// the token list and discarding the per-token cap the user deliberately set.
// Relay only rejects a finite token once it is exhausted
// (model/token.go:245), so a funded finite token must be reused as-is.
func TestEnsureUserModelKeyReusesFiniteQuotaPaidToken(t *testing.T) {
	db := setupTokenControllerTestDB(t)
	paid := seedQualifiedModelKeyToken(t, db, 212, "paid-token", "finite-paid-key")
	paid.UnlimitedQuota = false
	paid.RemainQuota = 100
	require.NoError(t, db.Save(paid).Error)

	key, err := ensureUserModelKey(212, "paid-user")
	require.NoError(t, err)
	assert.Equal(t, "finite-paid-key", key, "must reuse the user's own paid token")
	assert.EqualValues(t, 1, countUserModelTokens(t, db, 212), "must not mint a second token")
	assert.Equal(t, key, mustFindUserModelKey(t, 212))

	// The per-token cap the user set must survive untouched.
	var reloaded model.Token
	require.NoError(t, db.Where("user_id = ?", 212).First(&reloaded).Error)
	assert.False(t, reloaded.UnlimitedQuota)
	assert.Equal(t, 100, reloaded.RemainQuota)
}

// TestEnsureUserModelKeyPrefersOldestQualifiedToken pins stable selection when
// the user has several usable tokens: oldest id wins, so repeated calls never
// migrate the desktop client to a different key.
func TestEnsureUserModelKeyPrefersOldestQualifiedToken(t *testing.T) {
	db := setupTokenControllerTestDB(t)
	older := seedQualifiedModelKeyToken(t, db, 216, "older", "older-qualified-key")
	seedQualifiedModelKeyToken(t, db, 216, "newer", "newer-qualified-key")
	var newer model.Token
	require.NoError(t, db.Where("user_id = ? AND name = ?", 216, "newer").First(&newer).Error)
	require.Less(t, older.Id, newer.Id, "seed order must make 'older' the lowest id")

	key, err := ensureUserModelKey(216, "multi-token-user")
	require.NoError(t, err)
	assert.Equal(t, "older-qualified-key", key)
	assert.EqualValues(t, 2, countUserModelTokens(t, db, 216))
}

// TestPostSetupCreatesRootModelKey exercises the real PostSetup handler on an
// isolated SQLite database. It does not mock ensureUserModelKey: the assertion
// is that the root created by the bare DB.Create path ends up with exactly one
// qualified ordinary token, reachable via findUserModelKey.
func TestPostSetupCreatesRootModelKey(t *testing.T) {
	db := setupTokenControllerTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Option{}, &model.Setup{}))
	previous := constant.Setup
	constant.Setup = false
	previousMap := common.OptionMap
	common.OptionMap = map[string]string{}
	previousSelfUse := operation_setting.SelfUseModeEnabled
	previousDemo := operation_setting.DemoSiteEnabled
	previousAuto := setting.DefaultUseAutoGroup
	setting.DefaultUseAutoGroup = false
	t.Cleanup(func() {
		constant.Setup = previous
		common.OptionMap = previousMap
		operation_setting.SelfUseModeEnabled = previousSelfUse
		operation_setting.DemoSiteEnabled = previousDemo
		setting.DefaultUseAutoGroup = previousAuto
	})
	require.NoError(t, i18n.Init())

	body := `{"username":"setup-root","password":"setup-password-1","confirmPassword":"setup-password-1","SelfUseModeEnabled":false,"DemoSiteEnabled":false}`
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/setup", strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	PostSetup(c)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.True(t, constant.Setup)
	var root model.User
	require.NoError(t, db.Where("username = ?", "setup-root").First(&root).Error)
	require.Greater(t, root.Id, 0)
	assert.Equal(t, common.RoleRootUser, root.Role)
	assert.EqualValues(t, 1, countUserModelTokens(t, db, root.Id))
	key := mustFindUserModelKey(t, root.Id)
	assert.Len(t, key, 48)
	assert.False(t, strings.HasPrefix(key, "sk-"))
	assert.NotContains(t, recorder.Body.String(), key)

	var token model.Token
	require.NoError(t, db.Where("user_id = ?", root.Id).First(&token).Error)
	assert.EqualValues(t, -1, token.ExpiredTime)
	assert.True(t, token.UnlimitedQuota)
	assert.False(t, token.ModelLimitsEnabled)
	assert.True(t, token.AllowIps == nil || *token.AllowIps == "")
}

// TestEnsureUserModelKeyInheritsUserGroup pins that the created token leaves
// Group empty so relay's TokenAuth bills through the owner's own group.
//
// This deliberately does NOT set Group="auto" even when
// setting.DefaultUseAutoGroup is on: TokenAuth applies two serial checks to a
// non-empty token.Group (middleware/auth.go:624-638). The first looks the group
// up in service.GetUserUsableGroups(userGroup), whose default map
// (setting/user_usable_group.go) is only {default,vip} and does NOT contain
// "auto"; the "auto" exemption lives only in the second (group-ratio) check. So
// writing "auto" here would 403 MsgAuthTokenGroupForbidden at the first check
// with no desktop-side recovery. An empty Group inherits the owner's group and
// always passes.
func TestEnsureUserModelKeyInheritsUserGroup(t *testing.T) {
	db := setupTokenControllerTestDB(t)
	for _, autoGroup := range []bool{false, true} {
		previous := setting.DefaultUseAutoGroup
		setting.DefaultUseAutoGroup = autoGroup
		userId := 501
		if autoGroup {
			userId = 502
		}
		t.Cleanup(func() { setting.DefaultUseAutoGroup = previous })

		key, err := ensureUserModelKey(userId, "group-user")
		require.NoError(t, err)
		assert.Len(t, key, 48)

		var token model.Token
		require.NoError(t, db.Where("user_id = ?", userId).First(&token).Error)
		assert.Empty(t, token.Group, "must inherit the owner's group, never force auto")
		assert.Equal(t, key, mustFindUserModelKey(t, userId))

		// Idempotent: a second call reuses the same token, never mints another.
		again, err := ensureUserModelKey(userId, "group-user")
		require.NoError(t, err)
		assert.Equal(t, key, again)
		assert.EqualValues(t, 1, countUserModelTokens(t, db, userId))
	}
}

func TestEnsureUserModelKeyConcurrentCallsCreateOneToken(t *testing.T) {
	db := setupTokenControllerTestDB(t)
	const goroutines = 8
	results := make([]string, goroutines)
	errs := make([]error, goroutines)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			results[index], errs[index] = ensureUserModelKey(301, "concurrent-user")
		}(i)
	}
	close(start)
	wg.Wait()
	for i, err := range errs {
		require.NoError(t, err, "goroutine %d", i)
		assert.Len(t, results[i], 48)
		assert.Equal(t, results[0], results[i])
	}
	assert.EqualValues(t, 1, countUserModelTokens(t, db, 301))
}

func TestGetSelfModelKeyReturnsOnlyBareKey(t *testing.T) {
	db := setupTokenControllerTestDB(t)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/user/self/model-key", nil)
	c.Set("id", 401)
	c.Set("username", "desktop-user")

	GetSelfModelKey(c)
	assert.Equal(t, http.StatusOK, recorder.Code)

	var body map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	assert.Len(t, body, 3)
	assert.JSONEq(t, `true`, string(body["success"]))
	assert.JSONEq(t, `""`, string(body["message"]))
	var data map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(body["data"], &data))
	assert.Len(t, data, 1, "data must contain only key")
	var key string
	require.NoError(t, json.Unmarshal(data["key"], &key))
	assert.Len(t, key, 48)
	assert.False(t, strings.HasPrefix(key, "sk-"))
	assert.Equal(t, key, mustFindUserModelKey(t, 401))
	for _, sensitive := range []string{"id", "username", "password", "access_token", "token", "status", "quota", "name"} {
		assert.NotContains(t, recorder.Body.String(), `"`+sensitive+`"`)
	}

	// A subsequent fetch is cached by the caller in production; the endpoint
	// itself stays idempotent and never creates a second token.
	recorder = httptest.NewRecorder()
	c, _ = gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/user/self/model-key", nil)
	c.Set("id", 401)
	c.Set("username", "desktop-user")
	GetSelfModelKey(c)
	var second struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    struct {
			Key string `json:"key"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &second))
	assert.True(t, second.Success)
	assert.Empty(t, second.Message)
	assert.Equal(t, key, second.Data.Key)
	assert.EqualValues(t, 1, countUserModelTokens(t, db, 401))
}

func TestRegisterAutomaticallyCreatesModelKeyWithoutReturningIt(t *testing.T) {
	db := setupUserModelKeyRegisterTestDB(t)
	common.RegisterEnabled = true
	common.PasswordRegisterEnabled = true
	common.EmailVerificationEnabled = false
	common.QuotaForNewUser = 0

	username := "registered-model-key-user"
	body := fmt.Sprintf(`{"username":%q,"password":"register-password-1"}`, username)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/user/register", strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	Register(c)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.JSONEq(t, `{"success":true,"message":""}`, recorder.Body.String())
	var user model.User
	require.NoError(t, db.Where("username = ?", username).First(&user).Error)
	require.Greater(t, user.Id, 0)
	assert.EqualValues(t, 1, countUserModelTokens(t, db, user.Id))
	key := mustFindUserModelKey(t, user.Id)
	assert.Len(t, key, 48)
	assert.False(t, strings.HasPrefix(key, "sk-"))
	assert.NotContains(t, recorder.Body.String(), key)
	assert.NotContains(t, recorder.Body.String(), `"key"`)
}

func mustFindUserModelKey(t *testing.T, userId int) string {
	t.Helper()
	key, err := findUserModelKey(userId)
	require.NoError(t, err)
	require.NotEmpty(t, key)
	return key
}

// seedQualifiedModelKeyToken seeds an ordinary enabled token that satisfies
// every persisted relay criterion, without changing the shared seedToken helper.
func seedQualifiedModelKeyToken(t *testing.T, db *gorm.DB, userId int, name, key string) *model.Token {
	t.Helper()
	emptyIPs := ""
	token := &model.Token{
		UserId:             userId,
		Name:               name,
		Key:                key,
		Status:             common.TokenStatusEnabled,
		CreatedTime:        common.GetTimestamp(),
		AccessedTime:       common.GetTimestamp(),
		ExpiredTime:        -1,
		RemainQuota:        500000,
		UnlimitedQuota:     true,
		ModelLimitsEnabled: false,
		AllowIps:           &emptyIPs,
	}
	require.NoError(t, db.Create(token).Error)
	return token
}

func countUserModelTokens(t *testing.T, db *gorm.DB, userId int) int64 {
	t.Helper()
	var count int64
	require.NoError(t, db.Model(&model.Token{}).Where("user_id = ?", userId).Count(&count).Error)
	return count
}

type userModelKeyRegisterFlags struct {
	registerEnabled, passwordRegisterEnabled, emailVerificationEnabled bool
	quotaForNewUser                                                  int
	db, logDB                                                        *gorm.DB
	mainDatabaseType, logDatabaseType                                common.DatabaseType
	redisEnabled                                                     bool
}

func saveUserModelKeyRegisterFlags() func() {
	previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
	previousRedis := common.RedisEnabled
	state := userModelKeyRegisterFlags{
		registerEnabled:          common.RegisterEnabled,
		passwordRegisterEnabled:  common.PasswordRegisterEnabled,
		emailVerificationEnabled: common.EmailVerificationEnabled,
		quotaForNewUser:          common.QuotaForNewUser,
		db:                       model.DB,
		logDB:                    model.LOG_DB,
		mainDatabaseType:          previousMain,
		logDatabaseType:           previousLog,
		redisEnabled:              previousRedis,
	}
	return func() {
		common.RegisterEnabled = state.registerEnabled
		common.PasswordRegisterEnabled = state.passwordRegisterEnabled
		common.EmailVerificationEnabled = state.emailVerificationEnabled
		common.QuotaForNewUser = state.quotaForNewUser
		model.DB, model.LOG_DB = state.db, state.logDB
		common.SetDatabaseTypes(state.mainDatabaseType, state.logDatabaseType)
		common.RedisEnabled = state.redisEnabled
	}
}

func setupUserModelKeyRegisterTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	gin.SetMode(gin.TestMode)
	require.NoError(t, i18n.Init())
	previous := saveUserModelKeyRegisterFlags()
	t.Cleanup(previous)
	db, _ := newAuditTestDatabase(t, "sqlite", "")
	logDB, _ := newAuditTestDatabase(t, "sqlite", "")
	model.DB, model.LOG_DB = db, logDB
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	common.RedisEnabled = false
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}))
	require.NoError(t, logDB.AutoMigrate(&model.Log{}, &model.AuditLog{}))
	return db
}
