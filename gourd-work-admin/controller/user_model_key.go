package controller

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ensureUserModelKey returns a relay-acceptable ordinary token key owned by
// userId. The tokens table has no dedicated model-key type: we only ever reuse
// or create an ordinary token whose fields cannot make relay reject the key.
// A missing qualified key is created with the registration-default fields.
// Concurrent callers converge on one user token: the mutex and a database row
// lock serialize check-then-insert, the tokens table's unique key index is the
// final guard, and a conflict is resolved by re-querying.
var userModelKeyMu sync.Mutex

func ensureUserModelKey(userId int, username string) (string, error) {
	if userId <= 0 {
		return "", errors.New("invalid user id")
	}
	if key, err := findUserModelKey(userId); err != nil {
		return "", err
	} else if key != "" {
		return key, nil
	}

	userModelKeyMu.Lock()
	defer userModelKeyMu.Unlock()
	if key, err := findUserModelKey(userId); err != nil {
		return "", err
	} else if key != "" {
		return key, nil
	}

	key, err := common.GenerateKey()
	if err != nil {
		return "", fmt.Errorf("generate token key: %w", err)
	}
	now := common.GetTimestamp()
	token := model.Token{
		UserId:              userId,
		Name:                userModelKeyTokenName(username),
		Key:                 key,
		Status:              common.TokenStatusEnabled,
		CreatedTime:         now,
		AccessedTime:        now,
		ExpiredTime:         -1,
		RemainQuota:         500000,
		UnlimitedQuota:      true,
		AllowUserQuotaQuery: true,
	}
	// 【分组】刻意留空 → relay 的 TokenAuth 用 owner 自己的 group 计费。
	// 不要写 Group="auto"：TokenAuth 对非空 token.Group 有**两道**串行校验
	// （middleware/auth.go:624-638），第一道查 service.GetUserUsableGroups(userGroup)
	// 是否含该 group，而 setting.userUsableGroups 默认只有 {default,vip}，**不含
	// "auto"**；auto 的豁免只在第二道（group-ratio）里。因此即便部署开了
	// setting.DefaultUseAutoGroup，这里写 "auto" 也会在第一道被 403
	// MsgAuthTokenGroupForbidden 拒绝，且桌面端无从自愈。留空继承用户分组既
	// 100% 通过校验，也正是「按用户自己那套计费」的口径。
	createdKey := ""
	err = model.DB.Transaction(func(tx *gorm.DB) error {
		// A row lock serializes the same user across processes/replicas. SQLite
		// serializes writers at the database level, so FOR UPDATE is skipped.
		if err := lockUserForModelKey(tx, userId); err != nil {
			return err
		}
		existing, err := findUserModelKeyWithDB(tx, userId)
		if err != nil {
			return err
		}
		if existing != "" {
			createdKey = existing
			return nil
		}
		if err := tx.Create(&token).Error; err != nil {
			return err
		}
		createdKey = token.GetFullKey()
		return nil
	})
	if err != nil {
		// The unique key index is the final guard when a lock cannot be taken
		// (for example SQLite); re-read whichever token won the race.
		if isUniqueConflict(err) {
			existing, queryErr := findUserModelKey(userId)
			if queryErr != nil {
				return "", queryErr
			}
			if existing != "" {
				return existing, nil
			}
		}
		return "", err
	}
	return strings.TrimPrefix(createdKey, "sk-"), nil
}

func findUserModelKey(userId int) (string, error) {
	return findUserModelKeyWithDB(model.DB, userId)
}

// findUserModelKeyWithDB returns the oldest ordinary token whose persisted
// fields cannot make relay reject the key, or "" when none qualifies.
//
// 【计费口径】用户明确要求「就是用户自己的 key，按用户之前那套计费走」。
// relay 的用户级余额闸门在 service/billing_session.go::NewBillingSession 的
// tryWallet（`userQuota <= 0` → 403 ErrorCodeInsufficientUserQuota），结算在
// service/quota.go::postConsumeQuotaWithResult（`DecreaseUserQuota`）。
// `unlimited_quota` 只跳过 **token 级**独立限额（model/quota_reserve.go:209
// 的 `if unlimited { return true, ... }`），**跳不过用户钱包**。所以 unlimited
// 在这里是「token 不设独立上限、跟随钱包计费」，不是免费额度。
//
// 因此筛选条件必须**优先复用用户已有的合格 token**：早前一版把
// `unlimited_quota = true` 当成必要条件，用户自己那把设了独立额度的付费
// token 会被判不合格、被跳过，转而新建一把 unlimited token —— 既违背「用
// 之前那套 key」，又会污染 token 列表、绕过用户原本设的 token 级限额。
// 现在只要求「没过期 + 没耗尽」，unlimited 与有限额都合格。
//
// The predicates mirror ValidateUserToken (status, expiry, exhausted quota),
// TokenAuth (IP whitelist) and Distribute (model limits). UpdateToken can
// change expired_time / remain_quota / unlimited_quota / model_limits_enabled
// / allow_ips / group on any existing enabled token, so "status = enabled"
// alone is unsafe: a rejected key would surface as a desktop 401/403 and an
// empty model list.
//
// Not expressible in this SQL and intentionally left uncovered:
//   - Group: TokenAuth compares a non-empty token.Group against the *current*
//     owner's usable-group map and group ratios at request time; both live in
//     runtime settings and can change after this query runs. Tokens created
//     here leave Group empty (inherit the owner's group) — see
//     ensureUserModelKey.
//   - user.Status: TokenAuth rejects every token of a banned owner. No token
//     choice can repair that, and the desktop session is invalidated with the
//     user, so re-selecting here would be pointless.
//   - A finite token can be exhausted by the next relay call. That surfaces as
//     a desktop 401/403, whose re-fetch of /self/model-key re-runs this
//     selection and picks the next qualified token (or creates one). That is
//     the recovery path, not a SQL filter.
func findUserModelKeyWithDB(db *gorm.DB, userId int) (string, error) {
	now := common.GetTimestamp()
	var token model.Token
	err := db.Where("user_id = ? AND status = ?", userId, common.TokenStatusEnabled).
		Where("(expired_time = ? OR expired_time > ?)", -1, now).
		// 无限额度（跟随钱包）或仍有余量的有限额度都合格；只排除已耗尽的。
		Where("(unlimited_quota = ? OR remain_quota > ?)", true, 0).
		Where("model_limits_enabled = ?", false).
		Where("(allow_ips IS NULL OR allow_ips = '')").
		Order("id asc").First(&token).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	key := token.GetFullKey()
	if key == "" {
		return "", errors.New("qualified token has an empty key")
	}
	return strings.TrimPrefix(key, "sk-"), nil
}

func lockUserForModelKey(tx *gorm.DB, userId int) error {
	if !common.UsingMainDatabase(common.DatabaseTypeMySQL) &&
		!common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		return nil
	}
	var ids []int
	return tx.Raw("SELECT id FROM users WHERE id = ? FOR UPDATE", userId).Scan(&ids).Error
}

func userModelKeyTokenName(username string) string {
	// Registration used i18n.T with the request's language. This helper also
	// runs on paths with no request language, so translate with the configured
	// default. Init is idempotent and makes the helper safe in isolated tests.
	if err := i18n.Init(); err != nil {
		return i18n.MsgUserDefaultTokenName
	}
	return i18n.Translate(common.DefaultLanguage, i18n.MsgUserDefaultTokenName, map[string]any{"Username": username})
}

func isUniqueConflict(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unique constraint") ||
		strings.Contains(message, "duplicate key") ||
		strings.Contains(message, "duplicate entry") ||
		strings.Contains(message, "constraint failed: unique")
}

func ensureInitialModelKey(user *model.User) {
	if user == nil || user.Id <= 0 {
		return
	}
	if _, err := ensureUserModelKey(user.Id, user.Username); err != nil {
		common.SysLog(common.LogText("failed to ensure initial model key for user %d: %s", user.Id, err.Error()))
	}
}

// GetSelfModelKey serves the desktop client only. It is registered on the
// session-authenticated self route; admin web must not call or display it.
// The response deliberately contains only the bare key under data.key.
func GetSelfModelKey(c *gin.Context) {
	userId := c.GetInt("id")
	key, err := ensureUserModelKey(userId, c.GetString("username"))
	if err != nil {
		common.ApiErrorT(c, "Failed to get model key")
		common.SysLog(common.LogText("failed to ensure model key for user %d: %s", userId, err.Error()))
		return
	}
	common.ApiSuccess(c, gin.H{"key": key})
}
