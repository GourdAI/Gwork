package middleware

import (
	"os"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// allowedOriginsFromEnv 读取显式配置的跨域来源白名单。
//
// 格式：逗号分隔的完整 origin，例如
//
//	GWORK_CORS_ALLOWED_ORIGINS=https://admin.example.com,https://app.example.com
//
// 未配置时返回空切片（表示"没有可信第三方来源"）。
func allowedOriginsFromEnv() []string {
	raw := strings.TrimSpace(os.Getenv("GWORK_CORS_ALLOWED_ORIGINS"))
	if raw == "" {
		return nil
	}
	origins := make([]string, 0, 4)
	for _, part := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(part)
		// 尾斜杠会让浏览器端 origin 永远匹配不上，这里统一去掉
		origin = strings.TrimSuffix(origin, "/")
		if origin == "" || origin == "*" {
			// `*` 不是白名单，是"谁都能来"；忽略它，避免误配后静默放开
			continue
		}
		origins = append(origins, origin)
	}
	return origins
}

// CORS 跨域策略。
//
// 关键约束：浏览器规范禁止 `Access-Control-Allow-Origin: *` 与
// `Access-Control-Allow-Credentials: true` 同时生效（浏览器会直接拒绝带凭据的
// 响应），所以这两个开关必须二选一，不能"都要最宽松"。
//
// - 配置了 GWORK_CORS_ALLOWED_ORIGINS：只对该白名单回显 origin 并允许凭据。
// - 未配置（默认）：只回 `*` 且 **不允许凭据**。同源请求（后台前端与 API 同站点）
//   根本不走 CORS，行为不变；第三方 API 客户端用 Authorization 头，不受影响。
func CORS() gin.HandlerFunc {
	origins := allowedOriginsFromEnv()
	// 必须基于 DefaultConfig()：它携带 MaxAge(12h)、OptionsResponseStatusCode
	// 等库默认值。直接用零值 Config{} 会让预检响应丢失
	// `Access-Control-Max-Age`，浏览器把 12h 的预检缓存退化成 5s，高频 relay
	// 调用等于每个请求多一次 OPTIONS RTT —— 这是纯性能回归，不是安全取舍。
	config := cors.DefaultConfig()
	if len(origins) > 0 {
		config.AllowOrigins = origins
		config.AllowCredentials = true
	} else {
		config.AllowAllOrigins = true
		// 与 AllowAllOrigins 互斥地关闭凭据：通配来源 + 允许凭据在浏览器端本就
		// 无效（响应被拒），却让配置读起来像"允许任意站点带 cookie 访问"。
		config.AllowCredentials = false
	}
	// 与改前逐字一致（DefaultConfig 还含 PATCH/HEAD，这里不擅自放开）。
	config.AllowMethods = []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"}
	config.AllowHeaders = []string{"*"}
	return cors.New(config)
}

func Version() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-New-Api-Version", common.Version)
		c.Next()
	}
}
