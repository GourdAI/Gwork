package service

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupAuthSessionTestDB(t *testing.T) *model.User {
	t.Helper()
	previousDB, previousRedis := model.DB, common.RedisEnabled
	previousActiveLimit := common.UserSessionActiveLimit
	previousIssuanceLimit := common.UserSessionIssuanceLimit
	previousIssuanceWindow := common.UserSessionIssuanceWindowSeconds
	previousRevokedRetention := common.UserSessionRevokedRetentionDays
	previousAlertThreshold := common.UserSessionHourlyAlertThreshold
	// staleSweepAt 是进程级全局 map，而每个测试的 user 都来自全新 :memory:
	// DB（自增主键，Id 恒为 1）。不重置的话，前一个测试为「userId=1」记下的
	// 节流时间戳会静默跳过本测试的 lazy sweep —— 依赖 sweep 副作用的断言
	//（如 TestCreateLoginSessionIgnoresStaleAuthVersionsForActiveLimit 对
	// stale 行被撤销的断言）会在 -shuffle / -count>1 / 测试顺序变化时随机翻红。
	staleSweepMu.Lock()
	staleSweepAt = map[int]int64{}
	staleSweepMu.Unlock()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}, &model.AuthFlow{}, &model.UserAccessToken{}))
	model.DB = db
	common.RedisEnabled = false
	common.UserSessionActiveLimit = common.DefaultUserSessionActiveLimit
	common.UserSessionIssuanceLimit = common.DefaultUserSessionIssuanceLimit
	common.UserSessionIssuanceWindowSeconds = int64(common.DefaultUserSessionIssuanceWindowSeconds)
	common.UserSessionRevokedRetentionDays = common.DefaultUserSessionRevokedRetentionDays
	common.UserSessionHourlyAlertThreshold = common.DefaultUserSessionHourlyAlertThreshold
	t.Cleanup(func() {
		model.DB = previousDB
		common.RedisEnabled = previousRedis
		common.UserSessionActiveLimit = previousActiveLimit
		common.UserSessionIssuanceLimit = previousIssuanceLimit
		common.UserSessionIssuanceWindowSeconds = previousIssuanceWindow
		common.UserSessionRevokedRetentionDays = previousRevokedRetention
		common.UserSessionHourlyAlertThreshold = previousAlertThreshold
		// 恢复（清空）节流快照，与函数入口的重置对称：既保证本测试不影响
		// 后续测试，也保证并发 t.Parallel 下互不串扰。
		staleSweepMu.Lock()
		staleSweepAt = map[int]int64{}
		staleSweepMu.Unlock()
		_ = sqlDB.Close()
	})
	user := &model.User{
		Username:    "session-user",
		Password:    "unused-password-hash",
		Role:        common.RoleCommonUser,
		Status:      common.UserStatusEnabled,
		Group:       "default",
		AuthVersion: 1,
	}
	require.NoError(t, db.Create(user).Error)
	return user
}

func useIndependentAuthSessionRedis(t *testing.T) (*miniredis.Miniredis, *redis.Client, *miniredis.Miniredis, *redis.Client) {
	t.Helper()
	previousRedisEnabled := common.RedisEnabled
	previousRDB := common.RDB
	previousSyncFrequency := common.SyncFrequency
	serverA := miniredis.RunT(t)
	serverB := miniredis.RunT(t)
	clientA := redis.NewClient(&redis.Options{Addr: serverA.Addr()})
	clientB := redis.NewClient(&redis.Options{Addr: serverB.Addr()})
	common.RedisEnabled = true
	common.SyncFrequency = 2
	common.RDB = clientA
	t.Cleanup(func() {
		_ = clientA.Close()
		_ = clientB.Close()
		common.RedisEnabled = previousRedisEnabled
		common.RDB = previousRDB
		common.SyncFrequency = previousSyncFrequency
	})
	return serverA, clientA, serverB, clientB
}

func cachedLoginSessionKey(t *testing.T, server *miniredis.Miniredis) string {
	t.Helper()
	for _, key := range server.Keys() {
		if strings.HasPrefix(key, "auth:session:") {
			return key
		}
	}
	require.FailNow(t, "login session was not cached")
	return ""
}

// TestCreateLoginSessionIgnoresStaleAuthVersionsForActiveLimit replaces the
// previous "AcrossAuthVersions" contract, which asserted that a row left at a
// different auth version counted toward USER_SESSION_ACTIVE_LIMIT. That
// assertion was the bug, not its guard: such a row is rejected forever by
// ValidateLoginSession and hidden from the device list (ListActiveUserSessions
// filters on the current version), so it consumed a slot the user could neither
// see nor revoke. Accounts therefore drifted into a permanent
// 409 AUTH_SESSION_LIMIT with no signed-in device left to remediate from.
func TestCreateLoginSessionIgnoresStaleAuthVersionsForActiveLimit(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)
	common.UserSessionActiveLimit = 50
	common.UserSessionIssuanceLimit = 100
	now := time.Now().Unix()
	rows := make([]model.UserSession, 0, 49)
	for i := range 49 {
		authVersion := user.AuthVersion
		if i == 0 {
			// A row from a superseded auth version: unusable, and invisible in
			// the device list.
			authVersion++
		}
		rows = append(rows, model.UserSession{
			SID:             fmt.Sprintf("active-limit-%02d", i),
			UserID:          user.Id,
			Version:         1,
			UserAuthVersion: authVersion,
			Status:          model.UserSessionStatusActive,
			RefreshHash:     fmt.Sprintf("hash-%02d", i),
			LoginMethod:     "password",
			CreatedAt:       now - int64(i),
			LastActiveAt:    now - int64(i),
			ExpiresAt:       now + 3600,
		})
	}
	require.NoError(t, model.DB.Create(&rows).Error)

	// 48 usable + 1 stale. The stale row must not block issuance...
	_, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err, "a stale auth-version row must not consume the active limit")

	// ...and the lazy sweep must have revoked it, so it stops occupying storage
	// and stops being returned by any quota query.
	var stale model.UserSession
	require.NoError(t, model.DB.Where("sid = ?", "active-limit-00").First(&stale).Error)
	assert.Equal(t, model.UserSessionStatusRevoked, stale.Status)
	assert.Equal(t, "stale_auth_version", stale.RevokedReason)

	// 49 usable now, so a 50th still fits.
	_, err = CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err, "49 usable sessions must allow creation of the 50th")

	usable, err := model.CountUsableUserSessions(user.Id, user.AuthVersion, now)
	require.NoError(t, err)
	assert.Equal(t, int64(50), usable)
}

// TestCreateLoginSessionSweepsStaleOncePerInterval pins the per-user throttle:
// the lazy sweep must run for the first login of the hour and must NOT run for
// a second login within the interval — a repeated sweep would put the full
// batched-UPDATE cost back on the login critical path that the throttle
// exists to remove. The sweep itself is idempotent, so "skipped" is asserted
// behaviorally: a freshly planted stale row survives the second login (the
// hourly global backstop owns it from here).
func TestCreateLoginSessionSweepsStaleOncePerInterval(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)
	common.UserSessionActiveLimit = 50
	common.UserSessionIssuanceLimit = 100
	now := time.Now().Unix()

	plantStale := func(sid string) model.UserSession {
		row := model.UserSession{
			SID:             sid,
			UserID:          user.Id,
			Version:         1,
			UserAuthVersion: user.AuthVersion + 1, // stale: superseded auth version
			Status:          model.UserSessionStatusActive,
			RefreshHash:     "hash-" + sid,
			LoginMethod:     "password",
			CreatedAt:       now,
			LastActiveAt:    now,
			ExpiresAt:       now + 3600,
		}
		require.NoError(t, model.DB.Create(&row).Error)
		return row
	}

	// First login: sweep is due, the planted stale row must be revoked.
	plantStale("throttle-first")
	_, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err)
	var first model.UserSession
	require.NoError(t, model.DB.Where("sid = ?", "throttle-first").First(&first).Error)
	assert.Equal(t, model.UserSessionStatusRevoked, first.Status, "first login of the hour must sweep stale rows")

	// Second login within the interval: sweep is throttled. A new stale row
	// must survive this login (proving the sweep did not run again).
	plantStale("throttle-second")
	_, err = CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err)
	var second model.UserSession
	require.NoError(t, model.DB.Where("sid = ?", "throttle-second").First(&second).Error)
	assert.Equal(t, model.UserSessionStatusActive, second.Status, "second login within the interval must skip the sweep")
}

// TestCreateLoginSessionRetriesStaleSweepAfterFailure pins the split of
// judgment (staleSweepThrottled) from bookkeeping (markStaleSweepDone): a
// sweep that fails must not be silenced for the full hour — the next login
// must try again. Forced via the same gorm error-injection pattern used by
// TestCreateLoginSessionFailsClosedWhenLimitCountFails.
func TestCreateLoginSessionRetriesStaleSweepAfterFailure(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)
	common.UserSessionActiveLimit = 50
	common.UserSessionIssuanceLimit = 100
	now := time.Now().Unix()

	stale := model.UserSession{
		SID:             "throttle-retry",
		UserID:          user.Id,
		Version:         1,
		UserAuthVersion: user.AuthVersion + 1,
		Status:          model.UserSessionStatusActive,
		RefreshHash:     "hash-throttle-retry",
		LoginMethod:     "password",
		CreatedAt:       now,
		LastActiveAt:    now,
		ExpiresAt:       now + 3600,
	}
	require.NoError(t, model.DB.Create(&stale).Error)

	// Fail only the UPDATE path of the stale sweep (revoked-by-reason update
	// over user_sessions), then restore it so the retry can succeed.
	forcedErr := errors.New("forced stale sweep failure")
	callbackName := "test:fail_stale_sweep_update"
	callbackRegistered := true
	require.NoError(t, model.DB.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement != nil && tx.Statement.Table == "user_sessions" {
			tx.AddError(forcedErr)
		}
	}))
	t.Cleanup(func() {
		if callbackRegistered {
			_ = model.DB.Callback().Update().Remove(callbackName)
		}
	})

	_, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err, "a failed sweep must not fail the login itself")
	var afterFail model.UserSession
	require.NoError(t, model.DB.Where("sid = ?", "throttle-retry").First(&afterFail).Error)
	assert.Equal(t, model.UserSessionStatusActive, afterFail.Status, "the forced-failed sweep must leave the stale row untouched")

	require.NoError(t, model.DB.Callback().Update().Remove(callbackName))
	callbackRegistered = false

	// Next login must retry the sweep instead of honoring a throttle marker
	// that was never written for the failed attempt.
	_, err = CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err)
	var afterRetry model.UserSession
	require.NoError(t, model.DB.Where("sid = ?", "throttle-retry").First(&afterRetry).Error)
	assert.Equal(t, model.UserSessionStatusRevoked, afterRetry.Status, "a failed sweep must be retried on the next login")
}

// TestCreateLoginSessionEvictsIdlestAtActiveLimit pins the self-service escape
// hatch. At the cap the login must succeed by releasing the least recently used
// session: refusing with 409 left accounts locked out, because the only remedy
// (sign in on another device and revoke) was blocked by the error itself.
func TestCreateLoginSessionEvictsIdlestAtActiveLimit(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)
	common.UserSessionActiveLimit = 3
	common.UserSessionIssuanceLimit = 100
	now := time.Now().Unix()
	rows := make([]model.UserSession, 0, 3)
	for i := range 3 {
		rows = append(rows, model.UserSession{
			SID:             fmt.Sprintf("evict-candidate-%02d", i),
			UserID:          user.Id,
			Version:         1,
			UserAuthVersion: user.AuthVersion,
			Status:          model.UserSessionStatusActive,
			RefreshHash:     fmt.Sprintf("hash-%02d", i),
			LoginMethod:     "password",
			CreatedAt:       now - int64(i*100),
			// i=0 was used most recently, i=2 is the idlest — so candidate-02 is
			// the one eviction must take.
			LastActiveAt: now - int64(i*100),
			ExpiresAt:    now + 3600,
		})
	}
	require.NoError(t, model.DB.Create(&rows).Error)

	bundle, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err, "reaching the cap must evict the idlest session, not refuse the login")
	require.NotEmpty(t, bundle.AccessToken)

	var evicted model.UserSession
	require.NoError(t, model.DB.Where("sid = ?", "evict-candidate-02").First(&evicted).Error)
	assert.Equal(t, model.UserSessionStatusRevoked, evicted.Status)
	assert.Equal(t, "session_limit_evicted", evicted.RevokedReason)

	// The cap still holds: exactly one slot was reclaimed for exactly one new
	// session, and the two more recently used sessions survive.
	usable, err := model.CountUsableUserSessions(user.Id, user.AuthVersion, now)
	require.NoError(t, err)
	assert.Equal(t, int64(3), usable)
	for _, sid := range []string{"evict-candidate-00", "evict-candidate-01"} {
		var survivor model.UserSession
		require.NoError(t, model.DB.Where("sid = ?", sid).First(&survivor).Error)
		assert.Equal(t, model.UserSessionStatusActive, survivor.Status, "%s must survive", sid)
	}
}

// TestRevokeAllStaleUserSessionsSweepsEveryUser covers the hourly backstop: the
// lazy reclaim only runs for accounts that keep logging in, so an account that
// changed its password once and never returned would otherwise keep its
// unusable-but-active rows for the entire absolute session ceiling.
func TestRevokeAllStaleUserSessionsSweepsEveryUser(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)
	other := &model.User{
		Username: "session-user-2", Password: "unused-password-hash",
		Role: common.RoleCommonUser, Status: common.UserStatusEnabled,
		Group: "default", AuthVersion: 5, AffCode: "sweep-other",
	}
	require.NoError(t, model.DB.Create(other).Error)
	now := time.Now().Unix()
	rows := []model.UserSession{
		{ // stale: never logged in again after the version bump
			SID: "sweep-stale-other", UserID: other.Id, Version: 1, UserAuthVersion: 2,
			Status: model.UserSessionStatusActive, RefreshHash: "hash-a", LoginMethod: "password",
			CreatedAt: now, LastActiveAt: now, ExpiresAt: now + 3600,
		},
		{ // usable: must be untouched
			SID: "sweep-usable-other", UserID: other.Id, Version: 1, UserAuthVersion: 5,
			Status: model.UserSessionStatusActive, RefreshHash: "hash-b", LoginMethod: "password",
			CreatedAt: now, LastActiveAt: now, ExpiresAt: now + 3600,
		},
		{ // stale on the first user
			SID: "sweep-stale-user", UserID: user.Id, Version: 1, UserAuthVersion: user.AuthVersion + 1,
			Status: model.UserSessionStatusActive, RefreshHash: "hash-c", LoginMethod: "password",
			CreatedAt: now, LastActiveAt: now, ExpiresAt: now + 3600,
		},
		{ // already revoked and expired: not a candidate at all
			SID: "sweep-expired", UserID: user.Id, Version: 1, UserAuthVersion: user.AuthVersion + 1,
			Status: model.UserSessionStatusRevoked, RefreshHash: "hash-d", LoginMethod: "password",
			CreatedAt: now - 7200, LastActiveAt: now - 7200, ExpiresAt: now - 3600, RevokedAt: now - 3600,
		},
	}
	require.NoError(t, model.DB.Create(&rows).Error)

	revoked, err := model.RevokeAllStaleUserSessions("stale_auth_version_sweep")
	require.NoError(t, err)
	assert.Equal(t, int64(2), revoked, "both stale rows across both users must be swept")

	for _, sid := range []string{"sweep-stale-other", "sweep-stale-user"} {
		var row model.UserSession
		require.NoError(t, model.DB.Where("sid = ?", sid).First(&row).Error)
		assert.Equal(t, model.UserSessionStatusRevoked, row.Status, "%s must be revoked", sid)
	}
	var usableRow model.UserSession
	require.NoError(t, model.DB.Where("sid = ?", "sweep-usable-other").First(&usableRow).Error)
	assert.Equal(t, model.UserSessionStatusActive, usableRow.Status, "a usable session must survive the sweep")
}

// TestRefusedLoginNeverEvictsAnotherDevice pins the side-effect ordering.
//
// Eviction is irreversible: once a session row is flipped to revoked its device
// is signed out and cannot be brought back. So it may only run for a login that
// is actually going to be issued. When both growth limits are at their cap the
// issuance window wins, and it refuses unconditionally — evicting there would
// sign the user's other device out without signing them in anywhere, leaving the
// account strictly worse off than before the failed attempt.
//
// Both limits must be saturated at once for this to be observable. A test that
// only fills the issuance window (active limit still high) cannot tell the two
// orderings apart, because reclaim finds nothing to evict.
func TestRefusedLoginNeverEvictsAnotherDevice(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)
	// One usable session saturates the active cap AND sits inside the issuance
	// window, so both limits refuse on the same attempt.
	common.UserSessionActiveLimit = 1
	common.UserSessionIssuanceLimit = 1
	now := time.Now().Unix()
	victim := model.UserSession{
		SID: "issuance-refusal-victim", UserID: user.Id, Version: 1, UserAuthVersion: user.AuthVersion,
		Status: model.UserSessionStatusActive, RefreshHash: "victim-hash", LoginMethod: "password",
		CreatedAt: now - 10, LastActiveAt: now - 10, ExpiresAt: now + 3600,
	}
	require.NoError(t, model.DB.Create(&victim).Error)

	_, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	assert.ErrorIs(t, err, model.ErrUserSessionIssuanceLimit)

	var stored model.UserSession
	require.NoError(t, model.DB.Where("sid = ?", "issuance-refusal-victim").First(&stored).Error)
	assert.Equal(t, model.UserSessionStatusActive, stored.Status,
		"a refused login must not sign out another device")
	assert.Empty(t, stored.RevokedReason)
}


func TestCreateLoginSessionEnforcesIssuanceLimitAcrossAllStatuses(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)
	common.UserSessionActiveLimit = 10
	common.UserSessionIssuanceLimit = 3
	common.UserSessionIssuanceWindowSeconds = 60
	now := time.Now().Unix()
	rows := []model.UserSession{
		{
			SID: "issuance-limit-revoked", UserID: user.Id, Version: 1, UserAuthVersion: user.AuthVersion + 1,
			Status: model.UserSessionStatusRevoked, RefreshHash: "hash-revoked", LoginMethod: "password",
			CreatedAt: now - 2, LastActiveAt: now - 2, ExpiresAt: now + 3600, RevokedAt: now - 1,
		},
		{
			SID: "issuance-limit-expired", UserID: user.Id, Version: 1, UserAuthVersion: user.AuthVersion,
			Status: model.UserSessionStatusActive, RefreshHash: "hash-expired", LoginMethod: "password",
			CreatedAt: now - 1, LastActiveAt: now - 1, ExpiresAt: now - 1,
		},
		{
			SID: "issuance-outside-effective-window", UserID: user.Id, Version: 1, UserAuthVersion: user.AuthVersion,
			Status: model.UserSessionStatusRevoked, RefreshHash: "hash-outside", LoginMethod: "password",
			CreatedAt: now - 61, LastActiveAt: now - 61, ExpiresAt: now + 3600, RevokedAt: now - 60,
		},
	}
	require.NoError(t, model.DB.Create(&rows).Error)

	_, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err, "rows outside the effective issuance window must not consume the limit")

	_, err = CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	assert.ErrorIs(t, err, model.ErrUserSessionIssuanceLimit)
	var count int64
	require.NoError(t, model.DB.Model(&model.UserSession{}).Count(&count).Error)
	assert.Equal(t, int64(4), count)
}

func TestPasswordResetDoesNotClearSessionIssuanceHistory(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)
	common.UserSessionActiveLimit = 50
	common.UserSessionIssuanceLimit = 1
	email := "session-reset@example.com"
	require.NoError(t, model.DB.Model(user).Update("email", email).Error)

	_, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err)
	require.NoError(t, model.ResetUserPasswordByEmail(email, "new-password"))

	_, err = CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	assert.ErrorIs(t, err, model.ErrUserSessionIssuanceLimit)
}

func TestCreateLoginSessionFailsClosedWhenLimitCountFails(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)
	forcedErr := errors.New("forced session count failure")
	callbackName := "test:fail_user_session_limit_count"
	callbackRegistered := true
	require.NoError(t, model.DB.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement != nil && tx.Statement.Table == "user_sessions" {
			tx.AddError(forcedErr)
		}
	}))
	t.Cleanup(func() {
		if callbackRegistered {
			_ = model.DB.Callback().Query().Remove(callbackName)
		}
	})

	_, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	assert.ErrorIs(t, err, forcedErr)
	require.NoError(t, model.DB.Callback().Query().Remove(callbackName))
	callbackRegistered = false
	var count int64
	require.NoError(t, model.DB.Model(&model.UserSession{}).Count(&count).Error)
	assert.Zero(t, count)
}

func TestCleanupAuthArtifactsAlertsBeforeDeletingHourlyIssuance(t *testing.T) {
	setupAuthSessionTestDB(t)
	common.UserSessionHourlyAlertThreshold = 2
	common.UserSessionIssuanceWindowSeconds = 1
	now := time.Now()
	boundaryRows := make([]model.UserSession, 0, 2)
	for i := range 2 {
		boundaryRows = append(boundaryRows, model.UserSession{
			SID: "hourly-boundary-" + string(rune('a'+i)), UserID: 1, Version: 1, UserAuthVersion: 1,
			Status: model.UserSessionStatusActive, RefreshHash: "hash", LoginMethod: "password",
			CreatedAt: now.Add(-2 * time.Second).Unix(), LastActiveAt: now.Add(-time.Hour).Unix(), ExpiresAt: now.Add(-time.Minute).Unix(),
		})
	}
	require.NoError(t, model.DB.Create(&boundaryRows).Error)

	var logBuffer bytes.Buffer
	common.LogWriterMu.Lock()
	previousErrorWriter := gin.DefaultErrorWriter
	gin.DefaultErrorWriter = &logBuffer
	common.LogWriterMu.Unlock()
	t.Cleanup(func() {
		common.LogWriterMu.Lock()
		gin.DefaultErrorWriter = previousErrorWriter
		common.LogWriterMu.Unlock()
	})

	cleanupAuthArtifacts()
	assert.Empty(t, logBuffer.String(), "the hourly alert uses a strict greater-than threshold")
	var count int64
	require.NoError(t, model.DB.Model(&model.UserSession{}).Count(&count).Error)
	assert.Zero(t, count)

	exceededRows := make([]model.UserSession, 0, 3)
	for i := range 3 {
		exceededRows = append(exceededRows, model.UserSession{
			SID: "hourly-exceeded-" + string(rune('a'+i)), UserID: 1, Version: 1, UserAuthVersion: 1,
			Status: model.UserSessionStatusActive, RefreshHash: "hash", LoginMethod: "password",
			CreatedAt: now.Add(-2 * time.Second).Unix(), LastActiveAt: now.Add(-time.Hour).Unix(), ExpiresAt: now.Add(-time.Minute).Unix(),
		})
	}
	require.NoError(t, model.DB.Create(&exceededRows).Error)
	logBuffer.Reset()
	cleanupAuthArtifacts()
	assert.Contains(t, logBuffer.String(), "hourly user session issuance exceeded alert threshold")
	require.NoError(t, model.DB.Model(&model.UserSession{}).Count(&count).Error)
	assert.Zero(t, count, "alerting must happen before expired rows are deleted")
}

func TestCleanupAuthArtifactsRemovesOnlyExpiredRecords(t *testing.T) {
	setupAuthSessionTestDB(t)
	now := time.Now()
	oldExpiry := now.Add(-25 * time.Hour)
	require.NoError(t, model.DB.Create(&model.UserSession{
		SID: "expired-session", UserID: 1, Version: 1, UserAuthVersion: 1,
		Status: model.UserSessionStatusActive, RefreshHash: "hash", LoginMethod: "password",
		CreatedAt: oldExpiry.Unix(), LastActiveAt: oldExpiry.Unix(), ExpiresAt: oldExpiry.Unix(),
	}).Error)
	require.NoError(t, model.DB.Create(&model.AuthFlow{
		TokenHash: "expired-flow", Purpose: model.AuthFlowPurposeTwoFALogin,
		ExpiresAt: oldExpiry,
	}).Error)
	require.NoError(t, model.DB.Create(&model.AuthFlow{
		TokenHash: "recent-flow", Purpose: model.AuthFlowPurposeTwoFALogin,
		ExpiresAt: now.Add(time.Minute),
	}).Error)

	retention := time.Duration(common.UserSessionRevokedRetentionDays) * 24 * time.Hour
	for _, token := range []model.UserAccessToken{
		{Name: "past retention", TokenHash: "past-retention", ExpiresAt: now.Add(-retention - time.Hour).Unix()},
		{Name: "within retention", TokenHash: "within-retention", ExpiresAt: now.Add(-retention + time.Hour).Unix()},
		{Name: "never expires", TokenHash: "never-expires"},
	} {
		token.UserId = 1
		require.NoError(t, model.DB.Create(&token).Error)
	}

	cleanupAuthArtifacts()

	var sessionCount int64
	require.NoError(t, model.DB.Model(&model.UserSession{}).Count(&sessionCount).Error)
	assert.Zero(t, sessionCount)
	var flows []model.AuthFlow
	require.NoError(t, model.DB.Find(&flows).Error)
	require.Len(t, flows, 1)
	assert.Equal(t, "recent-flow", flows[0].TokenHash)
	var kept []string
	require.NoError(t, model.DB.Model(&model.UserAccessToken{}).Order("id").Pluck("token_hash", &kept).Error)
	assert.Equal(t, []string{"within-retention", "never-expires"}, kept)
}

func TestCleanupAuthArtifactsContinuesWithRevokedCleanupAfterExpiredBatchFailure(t *testing.T) {
	setupAuthSessionTestDB(t)
	now := time.Now()
	oldCreatedAt := now.Add(-8 * 24 * time.Hour).Unix()
	require.NoError(t, model.DB.Create(&[]model.UserSession{
		{
			SID: "failed-expired-cleanup", UserID: 1, Version: 1, UserAuthVersion: 1,
			Status: model.UserSessionStatusActive, RefreshHash: "hash-expired", LoginMethod: "password",
			CreatedAt: oldCreatedAt, LastActiveAt: oldCreatedAt, ExpiresAt: now.Add(-time.Minute).Unix(),
		},
		{
			SID: "independent-revoked-cleanup", UserID: 1, Version: 1, UserAuthVersion: 1,
			Status: model.UserSessionStatusRevoked, RefreshHash: "hash-revoked", LoginMethod: "password",
			CreatedAt: oldCreatedAt, LastActiveAt: oldCreatedAt, ExpiresAt: now.Add(time.Hour).Unix(),
			RevokedAt: now.Add(-8 * 24 * time.Hour).Unix(),
		},
	}).Error)

	forcedErr := errors.New("forced expired cleanup failure")
	callbackName := "test:fail_first_user_session_cleanup_batch"
	failedFirstDelete := false
	require.NoError(t, model.DB.Callback().Delete().Before("gorm:delete").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement != nil && tx.Statement.Table == "user_sessions" && !failedFirstDelete {
			failedFirstDelete = true
			tx.AddError(forcedErr)
		}
	}))
	t.Cleanup(func() { _ = model.DB.Callback().Delete().Remove(callbackName) })

	cleanupAuthArtifacts()

	var expired model.UserSession
	require.NoError(t, model.DB.First(&expired, "sid = ?", "failed-expired-cleanup").Error)
	var revoked model.UserSession
	assert.ErrorIs(t, model.DB.First(&revoked, "sid = ?", "independent-revoked-cleanup").Error, gorm.ErrRecordNotFound)
}

func TestLoginSessionRefreshSlidesExpiryButEnforcesAbsoluteCeiling(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)

	idleSecs := int64(LoginSessionTTL / time.Second)
	absoluteSecs := int64(LoginSessionAbsoluteTTL / time.Second)

	// ── A. Sliding renewal ───────────────────────────────────────────────
	// Simulate a session created 10 days ago whose idle window is about to
	// shrink: refresh must push expiry to now+TTL (i.e. forward by ~10 days),
	// not keep the original login-date deadline. Without backdating, a refresh
	// in the same second as login produces an identical Unix timestamp and the
	// assertion silently proves nothing.
	bundle, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err)
	assert.Equal(t, idleSecs, bundle.Session.ExpiresAt-bundle.Session.CreatedAt)
	agedCreated := bundle.Session.CreatedAt - 10*24*3600
	agedExpiry := agedCreated + idleSecs
	require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", bundle.Session.SID).
		Updates(map[string]any{"created_at": agedCreated, "expires_at": agedExpiry}).Error)

	refreshed, _, err := RefreshLoginSession(bundle.RefreshToken, bundle.Session.SID, "127.0.0.2", "test-agent-2")
	require.NoError(t, err)
	assert.Greater(t, refreshed.Session.ExpiresAt, agedExpiry, "refresh must slide the idle expiry forward")
	assert.LessOrEqual(t, refreshed.Session.ExpiresAt, agedCreated+absoluteSecs,
		"sliding renewal must never cross the absolute session ceiling")

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/user/auth/refresh", nil)
	WriteRefreshCookie(c, refreshed.RefreshToken)
	var refreshCookie *http.Cookie
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == RefreshCookieName {
			refreshCookie = cookie
		}
	}
	require.NotNil(t, refreshCookie, "refresh response must re-issue the rotating cookie")
	assert.Equal(t, refreshed.Session.ExpiresAt, refreshCookie.Expires.Unix(),
		"the cookie lifetime must follow the slid session deadline, not the original login date")

	// ── B. Absolute ceiling ──────────────────────────────────────────────
	// Keep the idle expiry alive (as sliding renewal would have done) but
	// backdate creation past the ceiling. The next refresh must force
	// re-authentication instead of extending the session forever.
	bundle2, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err)
	require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", bundle2.Session.SID).
		Updates(map[string]any{
			"created_at":  bundle2.Session.CreatedAt - absoluteSecs - 60,
			"expires_at": time.Now().Unix() + 3600,
		}).Error)
	_, _, err = RefreshLoginSession(bundle2.RefreshToken, bundle2.Session.SID, "127.0.0.2", "test-agent-2")
	assert.ErrorIs(t, err, ErrLoginSessionRevoked, "the absolute timeout must be enforced server-side")

	// ── C. Defensive fallback for an untrustworthy CreatedAt ─────────────
	// A cache snapshot with 0 (or future) CreatedAt must never derive a 1970
	// deadline and revoke an otherwise valid session.
	bundle3, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err)
	require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", bundle3.Session.SID).
		Update("created_at", int64(0)).Error)
	fallback, _, err := RefreshLoginSession(bundle3.RefreshToken, bundle3.Session.SID, "127.0.0.2", "test-agent-2")
	require.NoError(t, err, "an untrustworthy CreatedAt must not revoke an otherwise valid session")
	assert.Equal(t, bundle3.Session.ExpiresAt, fallback.Session.ExpiresAt,
		"the defensive fallback keeps the original idle window")
}

func TestLoginSessionCreateRefreshAndRevoke(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)

	bundle, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err)
	assert.NotEmpty(t, bundle.RefreshToken)
	identity, err := ParseAccessToken(bundle.AccessToken)
	require.NoError(t, err)
	_, cachedUser, err := ValidateLoginSession(identity)
	require.NoError(t, err)
	assert.Equal(t, user.Id, cachedUser.Id)
	require.NoError(t, RevokeByRefreshToken(bundle.Session.SID+".wrong-refresh-secret", "", "logout"))
	_, _, err = ValidateLoginSession(identity)
	require.NoError(t, err, "a caller that only knows sid must not be able to revoke the session")

	refreshed, _, err := RefreshLoginSession(bundle.RefreshToken, bundle.Session.SID, "127.0.0.2", "test-agent-2")
	require.NoError(t, err)
	assert.NotEqual(t, bundle.RefreshToken, refreshed.RefreshToken)
	recovered, _, err := RefreshLoginSession(bundle.RefreshToken, bundle.Session.SID, "127.0.0.2", "test-agent-2")
	require.NoError(t, err)
	assert.Equal(t, refreshed.RefreshToken, recovered.RefreshToken, "a concurrent refresh must recover the winner's rotated token")

	_, _, err = RefreshLoginSession(refreshed.RefreshToken, "different-session", "127.0.0.2", "test-agent-2")
	assert.ErrorIs(t, err, ErrLoginSessionMismatch)

	require.NoError(t, RevokeByRefreshToken(refreshed.RefreshToken, refreshed.Session.SID, "logout"))
	_, _, err = ValidateLoginSession(identity)
	assert.True(t, errors.Is(err, ErrLoginSessionRevoked))
}

func TestIndependentRedisSessionRevokeConvergesAfterCacheTTL(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)
	_, clientA, serverB, clientB := useIndependentAuthSessionRedis(t)

	common.RDB = clientA
	bundle, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "node-a")
	require.NoError(t, err)
	identity, err := ParseAccessToken(bundle.AccessToken)
	require.NoError(t, err)

	common.RDB = clientB
	_, _, err = ValidateLoginSession(identity)
	require.NoError(t, err)
	assert.NotEmpty(t, cachedLoginSessionKey(t, serverB), "node B must hold its own session cache entry")

	common.RDB = clientA
	require.NoError(t, RevokeByRefreshToken(bundle.RefreshToken, bundle.Session.SID, "logout"))

	serverB.FastForward(3 * time.Second)
	common.RDB = clientB
	_, _, err = ValidateLoginSession(identity)
	assert.ErrorIs(t, err, ErrLoginSessionRevoked)
}

func TestIndependentRedisAuthVersionAdvanceConvergesAfterCacheTTL(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)
	_, clientA, serverB, clientB := useIndependentAuthSessionRedis(t)

	common.RDB = clientA
	bundle, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "node-a")
	require.NoError(t, err)
	oldIdentity, err := ParseAccessToken(bundle.AccessToken)
	require.NoError(t, err)

	common.RDB = clientB
	_, _, err = ValidateLoginSession(oldIdentity)
	require.NoError(t, err)
	cacheKey := cachedLoginSessionKey(t, serverB)
	version := serverB.HGet(cacheKey, "Version")
	assert.Equal(t, "1", version, "node B must hold the pre-rotation session version")

	common.RDB = clientA
	rotated, err := AdvanceCurrentSessionSecurity(oldIdentity, "security_update")
	require.NoError(t, err)
	newIdentity, err := ParseAccessToken(rotated.AccessToken)
	require.NoError(t, err)
	assert.Greater(t, newIdentity.SessionVersion, oldIdentity.SessionVersion)
	assert.Greater(t, newIdentity.UserAuthVersion, oldIdentity.UserAuthVersion)

	serverB.FastForward(3 * time.Second)
	common.RDB = clientB
	_, _, err = ValidateLoginSession(newIdentity)
	require.NoError(t, err)
	_, _, err = ValidateLoginSession(oldIdentity)
	assert.ErrorIs(t, err, ErrLoginSessionRevoked)
}

func TestUserAuthVersionInvalidatesExistingSession(t *testing.T) {
	useTestSessionSecret(t)
	user := setupAuthSessionTestDB(t)
	bundle, err := CreateLoginSession(user.Id, "password", "127.0.0.1", "test-agent")
	require.NoError(t, err)
	identity, err := ParseAccessToken(bundle.AccessToken)
	require.NoError(t, err)

	_, err = model.BumpUserAuthVersion(user.Id)
	require.NoError(t, err)
	_, _, err = ValidateLoginSession(identity)
	assert.ErrorIs(t, err, ErrLoginSessionRevoked)
	_, err = CreateLoginSessionAtAuthVersion(user.Id, identity.UserAuthVersion, "2fa", "127.0.0.1", "test-agent")
	assert.ErrorIs(t, err, ErrLoginSessionRevoked, "a pending 2FA flow must not survive an auth-version change")
}
