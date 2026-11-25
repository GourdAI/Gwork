package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// The old CORS handler set AllowAllOrigins **and** AllowCredentials together.
// Browsers reject `Access-Control-Allow-Origin: *` on credentialed requests, so
// the pair was not exploitable — but it read as "any site may send cookies",
// and it is one library change away from becoming exactly that. These tests pin
// the safe pairing instead of the previous "both, widest" default.
func TestCORSWithoutAllowlistNeverCombinesWildcardWithCredentials(t *testing.T) {
	t.Setenv("GWORK_CORS_ALLOWED_ORIGINS", "")

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/probe", nil)
	request.Header.Set("Origin", "https://evil.example")
	newCORSTestRouter().ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "*", recorder.Header().Get("Access-Control-Allow-Origin"))
	require.Empty(t, recorder.Header().Get("Access-Control-Allow-Credentials"),
		"wildcard origin must not advertise credentials")
}

func TestCORSAllowlistEchoesOnlyConfiguredOrigins(t *testing.T) {
	t.Setenv("GWORK_CORS_ALLOWED_ORIGINS", "https://admin.example.com/, https://app.example.com")
	router := newCORSTestRouter()

	allowed := httptest.NewRecorder()
	allowedRequest := httptest.NewRequest(http.MethodGet, "/probe", nil)
	allowedRequest.Header.Set("Origin", "https://app.example.com")
	router.ServeHTTP(allowed, allowedRequest)
	require.Equal(t, "https://app.example.com", allowed.Header().Get("Access-Control-Allow-Origin"))
	require.Equal(t, "true", allowed.Header().Get("Access-Control-Allow-Credentials"))

	denied := httptest.NewRecorder()
	deniedRequest := httptest.NewRequest(http.MethodGet, "/probe", nil)
	deniedRequest.Header.Set("Origin", "https://evil.example")
	router.ServeHTTP(denied, deniedRequest)
	require.Empty(t, denied.Header().Get("Access-Control-Allow-Origin"),
		"an origin outside the allowlist must not be echoed back")
}

// A stray `*` in the allowlist would silently reopen the wildcard, so it is
// dropped at parse time rather than trusted.
func TestCORSAllowlistIgnoresWildcardAndBlankEntries(t *testing.T) {
	t.Setenv("GWORK_CORS_ALLOWED_ORIGINS", "*,  ,https://admin.example.com/")

	origins := allowedOriginsFromEnv()
	require.Equal(t, []string{"https://admin.example.com"}, origins)
}

func newCORSTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(CORS())
	router.GET("/probe", func(c *gin.Context) { c.Status(http.StatusOK) })
	router.OPTIONS("/probe", func(c *gin.Context) {
		// 预检必须被 cors 中间件 abort 掉；走到这里说明回归了（用 418 让断言可读）。
		c.Status(http.StatusTeapot)
	})
	return router
}

// Preflight caching is a *performance* contract, not a security one:
// gin-contrib/cors derives Access-Control-Max-Age from DefaultConfig().MaxAge
// (12h). Replacing DefaultConfig() with a zero-value cors.Config{} silently
// drops that header and browsers fall back to a ~5s preflight cache, adding an
// extra OPTIONS round trip to high-frequency relay calls. Pin it here so the
// regression cannot pass the suite green again.
func TestCORSPreflightKeepsMaxAgeAndAbortsBeforeHandler(t *testing.T) {
	for _, env := range []string{"", "https://admin.example.com"} {
		t.Run("allowlist="+env, func(t *testing.T) {
			t.Setenv("GWORK_CORS_ALLOWED_ORIGINS", env)
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodOptions, "/probe", nil)
			request.Header.Set("Origin", "https://admin.example.com")
			request.Header.Set("Access-Control-Request-Method", "POST")
			request.Header.Set("Access-Control-Request-Headers", "authorization,x-auth-session")
			newCORSTestRouter().ServeHTTP(recorder, request)

			require.Equal(t, http.StatusNoContent, recorder.Code)
			require.Contains(t, recorder.Header().Get("Access-Control-Allow-Methods"), "POST")
			require.NotEmpty(t, recorder.Header().Get("Access-Control-Allow-Headers"),
				"requested custom headers must be echoed")
			maxAge := recorder.Header().Get("Access-Control-Max-Age")
			require.NotEmpty(t, maxAge, "DefaultConfig().MaxAge must survive the allowlist refactor")
			require.Equal(t, "43200", maxAge, "12h preflight cache must be preserved")
			// Credentials must still never be combined with a wildcard origin.
			if env == "" {
				require.Equal(t, "*", recorder.Header().Get("Access-Control-Allow-Origin"))
				require.Empty(t, recorder.Header().Get("Access-Control-Allow-Credentials"))
			} else {
				require.Equal(t, "https://admin.example.com", recorder.Header().Get("Access-Control-Allow-Origin"))
				require.Equal(t, "true", recorder.Header().Get("Access-Control-Allow-Credentials"))
			}
		})
	}
}
