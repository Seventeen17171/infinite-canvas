package main

import (
	"log"
	"net"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/router"
	"github.com/tigerowo/infinite-canvas/service"
)

func main() {
	if err := config.Load(); err != nil {
		log.Fatal(err)
	}
	if err := service.EnsureDefaultAdmin(); err != nil {
		log.Fatal(err)
	}
	if !config.Cfg.DisablePromptSync {
		service.StartPromptSyncScheduler()
	}
	service.StartCanvasProjectCleanupScheduler()
	// Personal-balance tasks stay dormant until project-owned execution and settlement are connected.
	log.Fatal(router.New().Run(net.JoinHostPort(config.Cfg.BindHost, config.Cfg.Port)))
}
