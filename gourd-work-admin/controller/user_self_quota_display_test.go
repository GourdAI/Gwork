package controller

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/stretchr/testify/assert"
)

// formatQuotaForDisplay is the single server-side source of the balance
// string shipped to clients as `quota_display` (buildSelfUserData). Clients
// render it verbatim, so a regression here would put a raw quota integer or a
// mis-scaled amount on every user's account popover.
func TestFormatQuotaForDisplayFollowsSiteDisplayType(t *testing.T) {
	gen := operation_setting.GetGeneralSetting()
	prevType := gen.QuotaDisplayType
	prevSymbol := gen.CustomCurrencySymbol
	prevCustomRate := gen.CustomCurrencyExchangeRate
	prevUnit := common.QuotaPerUnit
	prevRate := operation_setting.USDExchangeRate
	t.Cleanup(func() {
		gen.QuotaDisplayType = prevType
		gen.CustomCurrencySymbol = prevSymbol
		gen.CustomCurrencyExchangeRate = prevCustomRate
		common.QuotaPerUnit = prevUnit
		operation_setting.USDExchangeRate = prevRate
	})

	common.QuotaPerUnit = 500000
	operation_setting.USDExchangeRate = 7

	gen.QuotaDisplayType = operation_setting.QuotaDisplayTypeUSD
	assert.Equal(t, "$10", formatQuotaForDisplay(5000000))
	assert.Equal(t, "$0.0025", formatQuotaForDisplay(1250), "sub-unit amounts keep 4 fraction digits")
	assert.Equal(t, "$0", formatQuotaForDisplay(0))
	/* Large balances must carry thousands separators, exactly like the web
	   console's Intl narrow-symbol output ($10,079.56, not $10079.56). */
	assert.Equal(t, "$10,079.56", formatQuotaForDisplay(5039778000), "large USD balance is grouped by thousands")
	/* A negative balance renders the sign BEFORE the symbol ("-$5"), never
	   between the symbol and the digits ("$-5"). */
	assert.Equal(t, "-$5", formatQuotaForDisplay(-2500000), "negative balance puts the sign before the symbol")

	gen.QuotaDisplayType = operation_setting.QuotaDisplayTypeCNY
	assert.Equal(t, "¥70", formatQuotaForDisplay(5000000), "CNY applies the USD exchange rate")

	gen.QuotaDisplayType = operation_setting.QuotaDisplayTypeTokens
	assert.Equal(t, "5,000,000", formatQuotaForDisplay(5000000), "TOKENS shows the grouped integer count")
	assert.Equal(t, "-5,000,000", formatQuotaForDisplay(-5000000), "negative TOKENS count keeps the leading sign")

	gen.QuotaDisplayType = operation_setting.QuotaDisplayTypeCustom
	gen.CustomCurrencySymbol = "¤"
	gen.CustomCurrencyExchangeRate = 2
	assert.Equal(t, "¤20", formatQuotaForDisplay(5000000))

	gen.CustomCurrencyExchangeRate = 0
	assert.Equal(t, "¤10", formatQuotaForDisplay(5000000), "a non-positive custom rate falls back to 1")
}

// buildSelfUserData must ship quota_display alongside the raw quota so the
// desktop popover never has to derive a display value client-side.
func TestBuildSelfUserDataCarriesServerFormattedBalance(t *testing.T) {
	gen := operation_setting.GetGeneralSetting()
	prevType := gen.QuotaDisplayType
	prevUnit := common.QuotaPerUnit
	t.Cleanup(func() {
		gen.QuotaDisplayType = prevType
		common.QuotaPerUnit = prevUnit
	})
	common.QuotaPerUnit = 500000
	gen.QuotaDisplayType = operation_setting.QuotaDisplayTypeUSD

	data := buildSelfUserData(&model.User{Id: 1, Username: "u", Quota: 5000000})
	assert.Equal(t, 5000000, data["quota"])
	assert.Equal(t, "$10", data["quota_display"], "clients render this string verbatim")
}
