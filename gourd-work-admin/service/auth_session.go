package service

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const RefreshCookieName = "new_api_refresh"

// SessionHintCookieName is the script-readable companion to RefreshCookieName.
// See writeSessionHintCookie for why it exists and what it is not.
const SessionHintCookieName = "new_api_has_session"

// SessionHintCookieValue is the only value the hint ever carries.
const SessionHintCookieValue = "1"

var (
	ErrLoginSessionInvalid  = errors.New("login session is invalid")
	ErrLoginSessionRevoked  = errors.New("login session is revoked")
	ErrLoginSessionMismatch = errors.New("login session does not match the expected session")
	ErrRefreshTokenInvalid  = errors.New("refresh token is invalid")
	ErrRefreshRace          = errors.New("refresh token was already rotated")
)

// Per-user stale-auth-version sweep throttle: the lazy sweep at login must not
// run on every single login for the same account. It is a batched UPDATE over
// user_sessions (deny fence + status flip), and it used to run unconditionally
// — a user who signs in repeatedly in a short window paid the full sweep cost
// each time, on the login critical path. One sweep per hour per user is enough:
// the hourly global backstop (RevokeAllStaleUserSessions in auth_cleanup.go)
// covers everything else, and a wrong version row cannot hold a usable quota
// slot anyway (CountUsableUserSessions filters on the current version).
var (
	staleSweepMu    sync.Mutex
	staleSweepAt    = map[int]int64{}
)

// staleSweepInterval bounds how often one user's login triggers the sweep.
const staleSweepInterval int64 = 3600

// staleSweepMaxUsers caps the throttle map: it is keyed by user id and would
// otherwise grow without bound for the lifetime of the process (every user
// that ever logs in leaves an entry). Clearing at the cap is safe — the sweep
// is idempotent and the hourly global backstop covers any row the lazy sweep
// skips, so the worst case of a reset is one extra sweep per affected user.
const staleSweepMaxUsers = 10000

// staleSweepThrottled reports whether a sweep for this user is due (true) or
// was performed recently (false). Judgment and bookkeeping are split so a
// sweep that fails can be retried on the next login instead of being silenced
// for the full hour.
func staleSweepThrottled(userID int) bool {
	staleSweepMu.Lock()
	defer staleSweepMu.Unlock()
	last, ok := staleSweepAt[userID]
	if ok && time.Now().Unix()-last < staleSweepInterval {
		return false
	}
	return true
}

func markStaleSweepDone(userID int) {
	staleSweepMu.Lock()
	defer staleSweepMu.Unlock()
	if len(staleSweepAt) >= staleSweepMaxUsers {
		staleSweepAt = map[int]int64{}
	}
	staleSweepAt[userID] = time.Now().Unix()
}

type LoginSessionView struct {
	SID          string `json:"sid"`
	Current      bool   `json:"current"`
	LoginMethod  string `json:"login_method"`
	IP           string `json:"ip"`
	UserAgent    string `json:"user_agent"`
	CreatedAt    int64  `json:"created_at"`
	LastActiveAt int64  `json:"last_active_at"`
	ExpiresAt    int64  `json:"expires_at"`
}

type AuthBundle struct {
	AccessToken     string           `json:"access_token"`
	TokenType       string           `json:"token_type"`
	AccessExpiresAt int64            `json:"access_expires_at"`
	Session         LoginSessionView `json:"session"`
	RefreshToken    string           `json:"-"`
}

func CreateLoginSession(userID int, loginMethod, ip, userAgent string) (*AuthBundle, error) {
	return createLoginSession(userID, 0, loginMethod, ip, userAgent)
}

func CreateLoginSessionAtAuthVersion(userID int, expectedAuthVersion int64, loginMethod, ip, userAgent string) (*AuthBundle, error) {
	if expectedAuthVersion <= 0 {
		return nil, ErrLoginSessionInvalid
	}
	return createLoginSession(userID, expectedAuthVersion, loginMethod, ip, userAgent)
}

func createLoginSession(userID int, expectedAuthVersion int64, loginMethod, ip, userAgent string) (*AuthBundle, error) {
	user, err := model.GetUserCache(userID)
	if err != nil {
		return nil, err
	}
	if user.Status != common.UserStatusEnabled || user.AuthVersion <= 0 {
		return nil, ErrLoginSessionInvalid
	}
	if expectedAuthVersion > 0 && user.AuthVersion != expectedAuthVersion {
		return nil, ErrLoginSessionRevoked
	}
	now := time.Now().Unix()
	activeCount, issuanceCount, err := countSessionGrowthLimits(userID, user.AuthVersion, now)
	if err != nil {
		return nil, err
	}
	if issuanceCount >= int64(common.UserSessionIssuanceLimit) {
		// Refuse before reclaim runs: this limit rejects unconditionally, and
		// evicting another device's session for a login that cannot succeed
		// would sign the user out elsewhere without signing them in anywhere.
		return nil, model.ErrUserSessionIssuanceLimit
	}
	activeAfterReclaim, err := reclaimUserSessionQuota(userID, user.AuthVersion, activeCount)
	if err != nil {
		return nil, err
	}
	if activeAfterReclaim >= int64(common.UserSessionActiveLimit) {
		// reclaimUserSessionQuota already swept and evicted; still at the cap
		// means nothing was evictable. Refuse explicitly rather than issuing an
		// over-limit session.
		return nil, model.ErrUserSessionLimit
	}
	session, refreshSecret, err := newLoginSession(userID, user.AuthVersion, loginMethod, ip, userAgent)
	if err != nil {
		return nil, err
	}
	if err := model.CreateUserSession(session); err != nil {
		return nil, err
	}
	bundle, err := issueAuthBundle(session, session.SID+"."+refreshSecret, true)
	if err != nil {
		_, _ = model.RevokeUserSession(userID, session.SID, "token_issue_failed")
		return nil, err
	}
	return bundle, nil
}

// countSessionGrowthLimits reads the two growth limits every session issuance
// shares. Splitting it out keeps the two issuance paths (createLoginSession and
// the 2FA/passkey flow) counting with identical semantics.
func countSessionGrowthLimits(userID int, authVersion int64, now int64) (int64, int64, error) {
	activeCount, err := model.CountUsableUserSessions(userID, authVersion, now)
	if err != nil {
		return 0, 0, err
	}
	issuanceCount, err := model.CountUserSessionsCreatedSince(userID, now-common.UserSessionIssuanceWindowSeconds)
	if err != nil {
		return 0, 0, err
	}
	return activeCount, issuanceCount, nil
}

// reclaimUserSessionQuota frees USER_SESSION_ACTIVE_LIMIT slots before a login
// issues its own session, and returns how many usable sessions are left
// afterwards so the caller can decide without a second read. Two things occupy
// slots that the user cannot free:
//
//  1. Stale auth-version rows. A security change (password, 2FA, passkey)
//     advances user_auth_version and invalidates every other session, but those
//     rows keep status=active until they expire — up to the 365-day absolute
//     ceiling. The device list filters on the current version, so they were
//     invisible: no row, no Revoke button, and no way to reclaim the slot except
//     from a device that was still signed in.
//  2. A genuine cap. With only the device list as an escape hatch, an account at
//     the cap could be locked out entirely — 409 AUTH_SESSION_LIMIT on every
//     login attempt, with the one remedy (sign in elsewhere and revoke) blocked
//     by the very error it was supposed to fix.
//
// So the idlest usable session yields its slot, and the caller counts only what
// remains.
//
// Eviction is an irreversible side effect, so it must only ever run for a login
// that is actually going to be issued. Callers therefore check the issuance
// window before calling this, and pass in the activeCount they already read: one
// read, one decision, and no eviction wasted on a login that was going to fail.
//
// Eviction runs outside any caller transaction on purpose: the deny fence has to
// be published before the status flip commits, and a fence published inside a
// transaction that later rolls back would leave a live session wrongly rejected.
func reclaimUserSessionQuota(userID int, authVersion int64, activeCount int64) (int64, error) {
	if userID <= 0 || authVersion <= 0 {
		return 0, ErrLoginSessionInvalid
	}
	if staleSweepThrottled(userID) {
		if _, err := model.RevokeStaleUserSessions(userID, authVersion, "stale_auth_version"); err != nil {
			// Not fatal for this login: CountUsableUserSessions already excludes
			// those rows, so a failed sweep only delays reclaiming the storage. Log
			// it so the fault stays visible instead of silently repeating on every
			// login for the same account.
			common.SysLog(common.LogText(
				"failed to revoke stale user sessions for user %d: %s", userID, err.Error()))
		} else {
			markStaleSweepDone(userID)
		}
	}
	if activeCount < int64(common.UserSessionActiveLimit) {
		return activeCount, nil
	}
	// Reserve exactly one slot for the session about to be issued.
	needed := activeCount - int64(common.UserSessionActiveLimit) + 1
	evicted, err := model.RevokeLeastRecentlyActiveUserSessions(
		userID, authVersion, "", needed, "session_limit_evicted",
	)
	if err != nil {
		return activeCount, err
	}
	if evicted == 0 {
		// Nothing was evictable (every candidate lost a concurrent revoke, or
		// the limit leaves no room). Let the caller surface AUTH_SESSION_LIMIT
		// rather than issuing an over-limit session.
		return activeCount, nil
	}
	common.SysLog(common.LogText(
		"user session limit reached; evicted least recently active sessions: user=%d evicted=%d active=%d limit=%d",
		userID, evicted, activeCount-evicted, common.UserSessionActiveLimit,
	))
	return activeCount - evicted, nil
}

func newLoginSession(userID int, authVersion int64, loginMethod, ip, userAgent string) (*model.UserSession, string, error) {
	refreshSecret, err := common.GenerateRandomCharsKey(64)
	if err != nil {
		return nil, "", err
	}
	now := time.Now().Unix()
	session := &model.UserSession{
		SID:             uuid.NewString(),
		UserID:          userID,
		Version:         1,
		UserAuthVersion: authVersion,
		Status:          model.UserSessionStatusActive,
		RefreshHash:     hashRefreshSecret(refreshSecret),
		LoginMethod:     strings.TrimSpace(loginMethod),
		IP:              truncateAuthMetadata(ip, 64),
		UserAgent:       truncateAuthMetadata(userAgent, 512),
		CreatedAt:       now,
		LastActiveAt:    now,
		ExpiresAt:       time.Unix(now, 0).Add(LoginSessionTTL).Unix(),
	}
	if session.LoginMethod == "" {
		session.LoginMethod = "unknown"
	}
	return session, refreshSecret, nil
}

func ValidateLoginSession(identity AuthIdentity) (*model.UserSession, *model.UserBase, error) {
	session, err := model.GetUserSessionCached(identity.SessionID)
	if err != nil {
		if errors.Is(err, model.ErrUserSessionInactive) {
			return nil, nil, ErrLoginSessionRevoked
		}
		return nil, nil, err
	}
	now := time.Now().Unix()
	if session.UserID != identity.UserID || session.Status != model.UserSessionStatusActive || session.RevokedAt != 0 || session.ExpiresAt <= now || session.Version != identity.SessionVersion || session.UserAuthVersion != identity.UserAuthVersion {
		return nil, nil, ErrLoginSessionRevoked
	}
	user, err := model.GetUserCache(identity.UserID)
	if err != nil {
		return nil, nil, err
	}
	if user.Status != common.UserStatusEnabled || user.AuthVersion != identity.UserAuthVersion {
		return nil, nil, ErrLoginSessionRevoked
	}
	return session, user, nil
}

// ValidateStepUpIdentity checks that the identity requesting or consuming a
// proof is still live: a browser session or a scoped access token.
func ValidateStepUpIdentity(identity AuthIdentity) error {
	if _, ok := model.ParseAccessTokenSessionID(identity.SessionID); ok {
		return model.ValidateAccessTokenIdentity(identity)
	}
	_, _, err := ValidateLoginSession(identity)
	return err
}

// ValidateSessionReference validates a server-side flow bound to an existing
// dashboard session without requiring an access token on the callback request.
func ValidateSessionReference(userID int, sid string) (AuthIdentity, error) {
	if userID <= 0 || strings.TrimSpace(sid) == "" {
		return AuthIdentity{}, ErrLoginSessionInvalid
	}
	session, err := model.GetUserSessionCached(sid)
	if err != nil {
		return AuthIdentity{}, err
	}
	identity := AuthIdentity{
		UserID:          userID,
		SessionID:       sid,
		UserAuthVersion: session.UserAuthVersion,
		SessionVersion:  session.Version,
	}
	if _, _, err := ValidateLoginSession(identity); err != nil {
		return AuthIdentity{}, err
	}
	return identity, nil
}

// AdvanceCurrentSessionSecurity increments the user's global auth version,
// preserves only the current browser session at a new session version and
// returns a replacement access token. Call after a successful 2FA/passkey
// security-setting mutation that did not already advance AuthVersion. When the
// change was made through an access token it returns a nil bundle.
func AdvanceCurrentSessionSecurity(identity AuthIdentity, reason string) (*AuthBundle, error) {
	nextUserAuthVersion, err := model.BumpUserAuthVersion(identity.UserID)
	if err != nil {
		return nil, err
	}
	return advanceCurrentSessionToVersion(identity, nextUserAuthVersion, reason)
}

// AdvanceCurrentSessionToUserVersion is used when the security mutation and
// AuthVersion increment were committed in the same transaction (for example,
// a password change).
func AdvanceCurrentSessionToUserVersion(identity AuthIdentity, reason string) (*AuthBundle, error) {
	user, err := model.GetUserCache(identity.UserID)
	if err != nil {
		return nil, err
	}
	if user.Status != common.UserStatusEnabled || user.AuthVersion <= identity.UserAuthVersion {
		return nil, ErrLoginSessionRevoked
	}
	return advanceCurrentSessionToVersion(identity, user.AuthVersion, reason)
}

func advanceCurrentSessionToVersion(identity AuthIdentity, nextUserAuthVersion int64, reason string) (*AuthBundle, error) {
	// An access token has no browser session to keep, so every browser session
	// signs in again at the new auth version. The token itself stays valid.
	if _, ok := model.ParseAccessTokenSessionID(identity.SessionID); ok {
		_, err := model.RevokeAllUserSessions(identity.UserID, reason)
		return nil, err
	}
	session, err := model.AdvanceUserSessionAuthVersion(
		identity.UserID,
		identity.SessionID,
		identity.SessionVersion,
		identity.UserAuthVersion,
		nextUserAuthVersion,
	)
	if err != nil {
		return nil, err
	}
	if _, err := model.RevokeOtherUserSessions(identity.UserID, identity.SessionID, reason); err != nil {
		return nil, err
	}
	return issueAuthBundle(session, "", true)
}

func RefreshLoginSession(rawRefreshToken, expectedSID, ip, userAgent string) (*AuthBundle, *model.User, error) {
	sid, secret, ok := splitRefreshToken(rawRefreshToken)
	if !ok {
		return nil, nil, ErrRefreshTokenInvalid
	}
	if expectedSID = strings.TrimSpace(expectedSID); expectedSID != "" && expectedSID != sid {
		return nil, nil, ErrLoginSessionMismatch
	}
	session, err := model.GetUserSessionCached(sid)
	if err != nil {
		if errors.Is(err, model.ErrUserSessionInactive) {
			return nil, nil, ErrLoginSessionRevoked
		}
		return nil, nil, ErrRefreshTokenInvalid
	}
	now := time.Now().Unix()
	if session.Status != model.UserSessionStatusActive || session.RevokedAt != 0 || session.ExpiresAt <= now {
		return nil, nil, ErrLoginSessionRevoked
	}
	// Session lifetime is enforced server-side (OWASP ASVS V3.3 / Session
	// Management Cheat Sheet). Every successful refresh slides the idle window
	// forward, but never past the absolute ceiling measured from session
	// creation. A client that keeps using the desktop app therefore stays
	// signed in without a hard 30-day logout, while a session stolen long ago
	// still expires and eventually forces re-authentication.
	//
	// CreatedAt comes from a cache snapshot; a stale/legacy entry can carry 0
	// or a future timestamp. In that case we must NOT derive a 1970 deadline
	// (which would revoke every live session on its next refresh). Fall back to
	// the conservative pre-change behaviour: keep the existing expiry untouched
	// so the session simply ages out on its original window.
	createdAt := session.CreatedAt
	trustworthyCreatedAt := createdAt > 0 && createdAt <= now
	var newExpiresAt int64
	if trustworthyCreatedAt {
		absoluteDeadline := createdAt + int64(LoginSessionAbsoluteTTL/time.Second)
		if absoluteDeadline <= now {
			_, _ = model.RevokeUserSession(session.UserID, session.SID, "absolute_session_timeout")
			return nil, nil, ErrLoginSessionRevoked
		}
		newExpiresAt = min(now+int64(LoginSessionTTL/time.Second), absoluteDeadline)
	} else {
		newExpiresAt = session.ExpiresAt
	}
	userCache, err := model.GetUserCache(session.UserID)
	if err != nil {
		return nil, nil, err
	}
	currentUser, err := model.GetSelfUserById(session.UserID)
	if err != nil {
		return nil, nil, err
	}
	if userCache.Status != common.UserStatusEnabled || userCache.AuthVersion != session.UserAuthVersion ||
		currentUser.Status != common.UserStatusEnabled || currentUser.AuthVersion != session.UserAuthVersion {
		_, _ = model.RevokeUserSession(session.UserID, session.SID, "user_security_changed")
		return nil, nil, ErrLoginSessionRevoked
	}
	nextSecret := deriveNextRefreshSecret(sid, secret)
	rotated, err := model.RotateUserSessionRefresh(session.UserID, sid, hashRefreshSecret(secret), hashRefreshSecret(nextSecret), now, RefreshReplayWindow, newExpiresAt)
	if err != nil {
		if errors.Is(err, model.ErrUserSessionRefreshRace) && rotated != nil &&
			hashRefreshSecret(nextSecret) == rotated.RefreshHash {
			bundle, issueErr := issueAuthBundle(rotated, sid+"."+nextSecret, true)
			if issueErr != nil {
				return nil, nil, issueErr
			}
			return bundle, currentUser, nil
		}
		if errors.Is(err, model.ErrUserSessionRefreshReuse) {
			return nil, nil, ErrLoginSessionRevoked
		}
		if errors.Is(err, model.ErrUserSessionRefreshInvalid) {
			return nil, nil, ErrRefreshTokenInvalid
		}
		if errors.Is(err, model.ErrUserSessionRefreshRace) {
			return nil, nil, ErrRefreshRace
		}
		return nil, nil, err
	}
	rotated.IP = truncateAuthMetadata(ip, 64)
	rotated.UserAgent = truncateAuthMetadata(userAgent, 512)
	bundle, err := issueAuthBundle(rotated, sid+"."+nextSecret, true)
	if err != nil {
		return nil, nil, err
	}
	return bundle, currentUser, nil
}

func RevokeByRefreshToken(rawRefreshToken, expectedSID, reason string) error {
	sid, secret, ok := splitRefreshToken(rawRefreshToken)
	if !ok {
		return nil
	}
	if expectedSID = strings.TrimSpace(expectedSID); expectedSID != "" && expectedSID != sid {
		return ErrLoginSessionMismatch
	}
	_, err := model.RevokeUserSessionByRefreshHash(sid, hashRefreshSecret(secret), reason)
	return err
}

func RefreshTokenSID(rawRefreshToken string) (string, bool) {
	sid, _, ok := splitRefreshToken(rawRefreshToken)
	return sid, ok
}

func ListLoginSessions(userID int, currentSID string) ([]LoginSessionView, error) {
	sessions, err := model.ListActiveUserSessions(userID, currentSID, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	views := make([]LoginSessionView, 0, len(sessions))
	for i := range sessions {
		views = append(views, sessionView(&sessions[i], sessions[i].SID == currentSID))
	}
	return views, nil
}

func WriteRefreshCookie(c *gin.Context, rawToken string) {
	expiresAt := time.Now().Add(LoginSessionTTL)
	if sid, _, ok := splitRefreshToken(rawToken); ok {
		if session, err := model.GetUserSessionCached(sid); err == nil && session.ExpiresAt > time.Now().Unix() {
			expiresAt = time.Unix(session.ExpiresAt, 0)
		}
	}
	maxAge := max(int(time.Until(expiresAt)/time.Second), 1)
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     RefreshCookieName,
		Value:    rawToken,
		Path:     "/api/user/auth",
		MaxAge:   maxAge,
		Expires:  expiresAt,
		HttpOnly: true,
		Secure:   common.SessionCookieSecure,
		SameSite: http.SameSiteStrictMode,
	})
	writeSessionHintCookie(c, maxAge, expiresAt)
}

func ClearRefreshCookie(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     RefreshCookieName,
		Value:    "",
		Path:     "/api/user/auth",
		MaxAge:   -1,
		Expires:  time.Unix(1, 0),
		HttpOnly: true,
		Secure:   common.SessionCookieSecure,
		SameSite: http.SameSiteStrictMode,
	})
	clearSessionHintCookie(c)
}

// writeSessionHintCookie mirrors the Refresh Cookie's lifetime with a
// script-readable marker. The Refresh Cookie itself is HttpOnly and scoped to
// /api/user/auth, so a page at / cannot tell whether a login session exists;
// without this hint the frontend has to POST /api/user/auth/refresh on every
// cold boot just to learn that an anonymous visitor is anonymous. That request
// is guaranteed to 401 and still consumes a slot of the IP-keyed
// CriticalRateLimit budget shared by everyone behind the same address.
//
// The value is the constant "1" and carries no credential: it states that a
// Refresh Cookie was issued, never who for. Authorization still derives solely
// from the Refresh Cookie and the Access Token, so forging this hint only costs
// the forger the round trip it was meant to avoid.
//
// It must be written and cleared in lockstep with the Refresh Cookie, which is
// why it lives inside these two helpers rather than at their call sites: both
// cookies then ride the same response with the same expiry, and no login path
// can set one without the other.
func writeSessionHintCookie(c *gin.Context, maxAge int, expiresAt time.Time) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     SessionHintCookieName,
		Value:    SessionHintCookieValue,
		Path:     "/",
		MaxAge:   maxAge,
		Expires:  expiresAt,
		HttpOnly: false,
		Secure:   common.SessionCookieSecure,
		SameSite: http.SameSiteStrictMode,
	})
}

func clearSessionHintCookie(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     SessionHintCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(1, 0),
		HttpOnly: false,
		Secure:   common.SessionCookieSecure,
		SameSite: http.SameSiteStrictMode,
	})
}

func issueAuthBundle(session *model.UserSession, rawRefreshToken string, current bool) (*AuthBundle, error) {
	identity := AuthIdentity{
		UserID:          session.UserID,
		SessionID:       session.SID,
		UserAuthVersion: session.UserAuthVersion,
		SessionVersion:  session.Version,
	}
	accessToken, accessExpiresAt, err := IssueAccessToken(identity)
	if err != nil {
		return nil, err
	}
	return &AuthBundle{
		AccessToken:     accessToken,
		TokenType:       "Bearer",
		AccessExpiresAt: accessExpiresAt,
		Session:         sessionView(session, current),
		RefreshToken:    rawRefreshToken,
	}, nil
}

func sessionView(session *model.UserSession, current bool) LoginSessionView {
	return LoginSessionView{
		SID:          session.SID,
		Current:      current,
		LoginMethod:  session.LoginMethod,
		IP:           session.IP,
		UserAgent:    session.UserAgent,
		CreatedAt:    session.CreatedAt,
		LastActiveAt: session.LastActiveAt,
		ExpiresAt:    session.ExpiresAt,
	}
}

func splitRefreshToken(raw string) (string, string, bool) {
	sid, secret, ok := strings.Cut(strings.TrimSpace(raw), ".")
	if !ok || sid == "" || secret == "" || strings.Contains(secret, ".") {
		return "", "", false
	}
	if _, err := uuid.Parse(sid); err != nil {
		return "", "", false
	}
	return sid, secret, true
}

func hashRefreshSecret(secret string) string {
	return common.GenerateHMACWithKey(authSigningKey("refresh"), secret)
}

func deriveNextRefreshSecret(sid, currentSecret string) string {
	return common.GenerateHMACWithKey(authSigningKey("refresh-rotate"), sid+"."+currentSecret)
}

func truncateAuthMetadata(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	return value[:max]
}

// authSessionErrorMessage returns an English, actionable sentence for a session
// error code.
//
// writeAuthSessionError used to answer with http.StatusText(status), so a
// session-limit refusal carried the single word "Conflict". The web console
// survived that because it translates `code` through serverErrorMessageKeys,
// but every other client has no such table: the Rust desktop shell concatenates
// `message` and `code` and showed "Conflict [AUTH_SESSION_LIMIT]", and the uni-app
// client surfaced `message` alone. Neither string tells the user what is wrong or
// what to do, which is exactly how a capacity problem ends up reported as a login
// bug. `code` stays machine-readable and unchanged; `message` becomes a sentence
// a human can act on.
var authSessionErrorMessages = map[string]string{
	"AUTH_SESSION_LIMIT":          "Your account has reached the maximum number of simultaneous sign-ins. The least recently used sign-in was released automatically; if you still cannot sign in, sign out other devices from Security > Login sessions, or reset your password to sign out everywhere.",
	"AUTH_SESSION_ISSUANCE_LIMIT": "Too many sign-ins were created for this account in the last 24 hours. Wait for the rolling window to pass, then try again.",
	"AUTH_SESSION_MISMATCH":       "This session identifier does not match the stored sign-in credential. Refresh the page to reload the current session, then try again.",
	"AUTH_REFRESH_RACE":           "Another request is refreshing this sign-in at the same time. Retry in a few seconds.",
	"AUTH_TOKEN_EXPIRED":          "Your sign-in has expired. Please sign in again.",
	"AUTH_SESSION_REVOKED":        "This sign-in was revoked, for example by a password change or by signing out on another device. Please sign in again.",
	"AUTH_UNAUTHORIZED":           "Your sign-in credential is missing or invalid. Please sign in again.",
	"AUTH_INTERNAL_ERROR":         "The sign-in service could not process this request. Please try again later.",
}

func authSessionErrorCode(err error) (int, string) {
	switch {
	case errors.Is(err, model.ErrUserSessionLimit):
		return http.StatusConflict, "AUTH_SESSION_LIMIT"
	case errors.Is(err, model.ErrUserSessionIssuanceLimit):
		return http.StatusTooManyRequests, "AUTH_SESSION_ISSUANCE_LIMIT"
	case errors.Is(err, ErrLoginSessionMismatch):
		return http.StatusConflict, "AUTH_SESSION_MISMATCH"
	case errors.Is(err, ErrRefreshRace):
		return http.StatusConflict, "AUTH_REFRESH_RACE"
	case errors.Is(err, ErrAuthTokenExpired):
		return http.StatusUnauthorized, "AUTH_TOKEN_EXPIRED"
	case errors.Is(err, ErrLoginSessionRevoked):
		return http.StatusUnauthorized, "AUTH_SESSION_REVOKED"
	case errors.Is(err, ErrRefreshTokenInvalid), errors.Is(err, ErrAuthTokenInvalid):
		return http.StatusUnauthorized, "AUTH_UNAUTHORIZED"
	default:
		return http.StatusInternalServerError, "AUTH_INTERNAL_ERROR"
	}
}

func AuthSessionErrorCode(err error) (int, string) {
	return authSessionErrorCode(err)
}

// AuthSessionErrorMessage maps a session error code to its user-facing English
// message, falling back to the HTTP status text for codes with no entry.
func AuthSessionErrorMessage(status int, code string) string {
	if message, ok := authSessionErrorMessages[code]; ok {
		return message
	}
	return http.StatusText(status)
}

func FormatAuthError(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf("authentication failed: %v", err)
}
