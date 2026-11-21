// 联调辅助（仅本地）：为指定 userId 铸真实登录会话 AuthBundle + RefreshToken。
// 编译产物 .gwork/mobile-link/linkmint（容器内 /work/linkmint），用完可删本目录。
package main

import (
	"fmt"
	"os"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
)

func main() {
	uid, _ := strconv.Atoi(os.Args[1])
	common.InitEnv()
	if err := common.InitRedisClient(); err != nil {
		fmt.Fprintln(os.Stderr, "redis init failed:", err)
		os.Exit(1)
	}
	if err := model.InitDB(); err != nil {
		fmt.Fprintln(os.Stderr, "db init failed:", err)
		os.Exit(1)
	}
	bundle, err := service.CreateLoginSession(uid, "password", "127.0.0.1", "gwork-link-e2e")
	if err != nil {
		fmt.Fprintln(os.Stderr, "mint failed:", err)
		os.Exit(1)
	}
	var m map[string]interface{}
	raw, _ := common.Marshal(bundle)
	if err := common.Unmarshal(raw, &m); err != nil {
		fmt.Fprintln(os.Stderr, "unmarshal failed:", err)
		os.Exit(1)
	}
	m["refresh_token"] = bundle.RefreshToken
	out, _ := common.Marshal(m)
	fmt.Println(string(out))
}