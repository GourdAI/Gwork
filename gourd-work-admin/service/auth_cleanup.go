package service

import (
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const authArtifactCleanupInterval = time.Hour

// StartAuthArtifactCleanup removes expired dashboard Sessions, old one-time
// authentication flows and access tokens that expired beyond the revoked
// session retention. Only the master instance performs cleanup.
func StartAuthArtifactCleanup() {
	if !common.IsMasterNode {
		return
	}
	go func() {
		cleanupAuthArtifacts()
		ticker := time.NewTicker(authArtifactCleanupInterval)
		defer ticker.Stop()
		for range ticker.C {
			cleanupAuthArtifacts()
		}
	}()
}

func cleanupAuthArtifacts() {
	now := time.Now()
	count, err := model.CountUserSessionsCreatedSince(0, now.Add(-time.Hour).Unix())
	if err != nil {
		common.SysError(common.LogText("failed to count hourly user session issuance: %s", err.Error()))
	} else if count > int64(common.UserSessionHourlyAlertThreshold) {
		common.SysError(common.LogText(
			"hourly user session issuance exceeded alert threshold: count=%d threshold=%d window_seconds=%d",
			count,
			common.UserSessionHourlyAlertThreshold,
			int64(time.Hour/time.Second),
		))
	}
	if err := model.DeleteExpiredUserSessions(now.Unix()); err != nil {
		common.SysError(common.LogText("failed to delete expired user sessions: %s", err.Error()))
	}
	// Backstop for stale auth-version rows: the lazy reclaim at login only runs
	// for accounts that keep logging in. An account whose security settings
	// changed once and never signed in again keeps its unusable-but-active rows
	// for the whole absolute session ceiling, which is why this sweep belongs in
	// the hourly task and not only in the login path.
	if revoked, err := model.RevokeAllStaleUserSessions("stale_auth_version_sweep"); err != nil {
		common.SysError(common.LogText("failed to revoke stale user sessions: %s", err.Error()))
	} else if revoked > 0 {
		common.SysLog(common.LogText("revoked stale auth-version user sessions: count=%d", revoked))
	}
	if err := model.DeleteOldRevokedUserSessions(now.Unix()); err != nil {
		common.SysError(common.LogText("failed to delete old revoked user sessions: %s", err.Error()))
	}
	if err := model.DeleteExpiredAuthFlows(now); err != nil {
		common.SysError(common.LogText("failed to delete expired authentication flows: %s", err.Error()))
	}
	accessTokenExpiredBefore := now.Unix() - int64(common.UserSessionRevokedRetentionDays)*24*60*60
	if err := model.DeleteExpiredUserAccessTokens(accessTokenExpiredBefore); err != nil {
		common.SysError(common.LogText("failed to delete expired access tokens: %s", err.Error()))
	}
}
