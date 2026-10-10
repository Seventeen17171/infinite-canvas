package router

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/middleware"
)

func New() *gin.Engine {
	router := gin.Default()
	router.RedirectTrailingSlash = false
	_ = router.SetTrustedProxies(nil)
	api := router.Group("/api")
	// This runs before UserAuth so rejected file requests cannot acquire public cache headers.
	api.Use(func(c *gin.Context) {
		path := c.Request.URL.Path
		if strings.HasPrefix(path, "/api/files/") || strings.HasPrefix(path, "/api/anonymous/files") || strings.HasPrefix(path, "/api/v1/files") ||
			(strings.HasPrefix(path, "/api/v1/production/") && (strings.Contains(path, "/files") || strings.Contains(path, "/file-uploads/"))) {
			handler.PrivateFileHeaders(c.Writer)
		}
		c.Next()
	})
	api.GET("/health", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})
	api.POST("/auth/register", gin.WrapF(handler.Register))
	api.POST("/auth/login", gin.WrapF(handler.Login))
	api.GET("/auth/linux-do/authorize", gin.WrapF(handler.LinuxDoAuthorize))
	api.GET("/auth/linux-do/callback", gin.WrapF(handler.LinuxDoCallback))
	api.GET("/auth/me", middleware.OptionalAuth, gin.WrapF(handler.CurrentUser))
	api.GET("/settings", gin.WrapF(handler.Settings))
	api.GET("/storage/config", gin.WrapF(handler.StorageConfig))
	for _, path := range []string{"/files/:id", "/files/:id/content"} {
		api.GET(path, gin.WrapF(handler.LegacyFileRead))
		api.HEAD(path, gin.WrapF(handler.LegacyFileRead))
	}
	anonymousFiles := api.Group("/anonymous/files")
	anonymousFiles.POST("/session", gin.WrapF(handler.ProjectFileEntryRequired))
	anonymousFiles.POST("", gin.WrapF(handler.ProjectFileEntryRequired))
	anonymousFiles.DELETE("/:id", gin.WrapF(handler.ProjectFileEntryRequired))
	v1 := api.Group("/v1", middleware.UserAuth)
	production := v1.Group("/production")
	production.GET("/projects", gin.WrapF(handler.ProductionProjects))
	production.POST("/projects", gin.WrapF(handler.CreateProductionProject))
	production.GET("/producers", gin.WrapF(handler.ProductionProducers))
	production.GET("/projects/:id", func(c *gin.Context) { handler.GetProductionProject(c.Writer, c.Request, c.Param("id")) })
	production.GET("/projects/:id/assets", func(c *gin.Context) { handler.ProductionAssets(c.Writer, c.Request, c.Param("id")) })
	production.GET("/projects/:id/assets/:assetId/files", func(c *gin.Context) {
		handler.ProductionFiles(c.Writer, c.Request, c.Param("id"), c.Param("assetId"))
	})
	production.POST("/projects/:id/assets/:assetId/files", func(c *gin.Context) {
		handler.UploadProductionFile(c.Writer, c.Request, c.Param("id"), c.Param("assetId"))
	})
	production.GET("/projects/:id/assets/:assetId/file-uploads/:requestId", func(c *gin.Context) {
		handler.GetProductionFileUpload(c.Writer, c.Request, c.Param("id"), c.Param("assetId"), c.Param("requestId"))
	})
	production.GET("/projects/:id/files/:fileId", func(c *gin.Context) {
		handler.GetProductionFile(c.Writer, c.Request, c.Param("id"), c.Param("fileId"))
	})
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		production.Handle(method, "/projects/:id/files/:fileId/content", func(c *gin.Context) {
			handler.ProductionFileContent(c.Writer, c.Request, c.Param("id"), c.Param("fileId"))
		})
	}
	production.POST("/projects/:id/assets", func(c *gin.Context) { handler.CreateProductionAsset(c.Writer, c.Request, c.Param("id")) })
	production.GET("/projects/:id/assets/:assetId", func(c *gin.Context) {
		handler.GetProductionAsset(c.Writer, c.Request, c.Param("id"), c.Param("assetId"))
	})
	production.PUT("/projects/:id/assets/:assetId", func(c *gin.Context) {
		handler.SaveProductionAsset(c.Writer, c.Request, c.Param("id"), c.Param("assetId"))
	})
	production.GET("/projects/:id/assets/:assetId/creative", func(c *gin.Context) {
		handler.GetProductionAssetCreative(c.Writer, c.Request, c.Param("id"), c.Param("assetId"))
	})
	production.PUT("/projects/:id/assets/:assetId/creative", func(c *gin.Context) {
		handler.SaveProductionAssetCreative(c.Writer, c.Request, c.Param("id"), c.Param("assetId"))
	})
	production.GET("/projects/:id/budget", func(c *gin.Context) { handler.ProductionProjectBudget(c.Writer, c.Request, c.Param("id")) })
	production.POST("/projects/:id/budget-applications", func(c *gin.Context) { handler.ApplyProductionProjectBudget(c.Writer, c.Request, c.Param("id")) })
	production.GET("/projects/:id/workspaces/:kind", func(c *gin.Context) {
		handler.GetProductionWorkspace(c.Writer, c.Request, c.Param("id"), c.Param("kind"))
	})
	production.POST("/projects/:id/assignment", func(c *gin.Context) { handler.AssignProductionProject(c.Writer, c.Request, c.Param("id")) })
	production.GET("/projects/:id/workspaces/:kind/documents", func(c *gin.Context) {
		handler.ProductionCanvasDocuments(c.Writer, c.Request, c.Param("id"), c.Param("kind"))
	})
	production.POST("/projects/:id/workspaces/:kind/documents", func(c *gin.Context) {
		handler.CreateProductionCanvasDocument(c.Writer, c.Request, c.Param("id"), c.Param("kind"))
	})
	production.GET("/projects/:id/workspaces/:kind/documents/:documentId", func(c *gin.Context) {
		handler.GetProductionCanvasDocument(c.Writer, c.Request, c.Param("id"), c.Param("kind"), c.Param("documentId"))
	})
	production.PUT("/projects/:id/workspaces/:kind/documents/:documentId", func(c *gin.Context) {
		handler.SaveProductionCanvasDocument(c.Writer, c.Request, c.Param("id"), c.Param("kind"), c.Param("documentId"))
	})
	v1.POST("/model-channels/autodl/workflows", gin.WrapF(handler.UserAutoDLWorkflows))
	v1.POST("/images/generations", gin.WrapF(handler.ProjectModelTaskRequired))
	v1.POST("/images/edits", gin.WrapF(handler.ProjectModelTaskRequired))
	v1.POST("/responses", gin.WrapF(handler.ProjectModelTaskRequired))
	v1.POST("/chat/completions", gin.WrapF(handler.ProjectModelTaskRequired))
	v1.POST("/audio/speech", gin.WrapF(handler.ProjectModelTaskRequired))
	v1.GET("/tts/voices", gin.WrapF(handler.AITTSVoices))
	v1.POST("/canvas/tasks/delete", gin.WrapF(handler.DeleteUserCanvasTasks))
	v1.POST("/canvas/image-tasks", gin.WrapF(handler.ProjectModelTaskRequired))
	v1.GET("/canvas/image-tasks", gin.WrapF(handler.UserCanvasImageTasks))
	v1.POST("/canvas/image-tasks/status", gin.WrapF(handler.BatchCanvasImageTasks))
	v1.GET("/canvas/image-tasks/:id", func(c *gin.Context) {
		handler.GetCanvasImageTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.DELETE("/canvas/image-tasks/:id", func(c *gin.Context) {
		handler.DeleteUserCanvasImageTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/canvas/audio-tasks", gin.WrapF(handler.ProjectModelTaskRequired))
	v1.GET("/canvas/audio-tasks/:id", func(c *gin.Context) {
		handler.GetCanvasAudioTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/videos", gin.WrapF(handler.ProjectModelTaskRequired))
	v1.GET("/video-tasks", gin.WrapF(handler.UserVideoTasks))
	v1.DELETE("/video-tasks/:id", func(c *gin.Context) {
		handler.DeleteUserVideoTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/videos/:id", func(c *gin.Context) {
		handler.AIVideo(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/videos/:id/content", func(c *gin.Context) {
		handler.AIVideoContent(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/workflows", gin.WrapF(handler.UserWorkflows))
	v1.POST("/workflows", gin.WrapF(handler.SaveUserWorkflow))
	v1.POST("/workflows/agent-draft", gin.WrapF(handler.ProjectModelTaskRequired))
	v1.DELETE("/workflows/:id", func(c *gin.Context) {
		handler.DeleteUserWorkflow(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/storage/measure", gin.WrapF(handler.MeasureUserStorageProvider))
	v1.POST("/files", gin.WrapF(handler.ProjectFileEntryRequired))
	v1.POST("/files/direct", gin.WrapF(handler.ProjectFileEntryRequired))
	v1.DELETE("/files/:id", gin.WrapF(handler.ProjectFileEntryRequired))
	v1.DELETE("/files/:id/record", gin.WrapF(handler.ProjectFileEntryRequired))
	v1.GET("/user-config", gin.WrapF(handler.UserConfig))
	v1.POST("/workflow-tasks", gin.WrapF(handler.ProjectModelTaskRequired))
	v1.GET("/workflow-tasks/:id", gin.WrapF(handler.ProjectModelTaskRequired))
	v1.POST("/user-config/storage", gin.WrapF(handler.SaveUserStorageProvider))
	v1.GET("/canvas/projects", gin.WrapF(handler.UserCanvasProjects))
	v1.POST("/canvas/projects", gin.WrapF(handler.SaveUserCanvasProject))
	v1.POST("/canvas/projects/sync", gin.WrapF(handler.SyncUserCanvasProjects))
	v1.POST("/canvas/projects/delete", gin.WrapF(handler.DeleteUserCanvasProjects))
	v1.GET("/user-data/image-history", gin.WrapF(handler.UserImageHistory))
	v1.POST("/user-data/image-history", gin.WrapF(handler.SaveUserImageHistory))
	v1.GET("/generation-logs/videos", gin.WrapF(handler.UserVideoGenerationLogs))
	v1.POST("/generation-logs/videos", gin.WrapF(handler.SaveUserVideoGenerationLogs))
	v1.POST("/generation-logs/videos/delete", gin.WrapF(handler.DeleteUserVideoGenerationLogs))
	v1.DELETE("/generation-logs/videos/:id", func(c *gin.Context) {
		handler.DeleteUserVideoGenerationLog(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/generation-logs/images", gin.WrapF(handler.UserImageGenerationLogs))
	v1.POST("/generation-logs/images", gin.WrapF(handler.SaveUserImageGenerationLogs))
	v1.POST("/generation-logs/images/delete", gin.WrapF(handler.DeleteUserImageGenerationLogs))
	v1.DELETE("/generation-logs/images/:id", func(c *gin.Context) {
		handler.DeleteUserImageGenerationLog(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/user-data/assets", gin.WrapF(handler.UserAssetData))
	v1.POST("/user-data/assets", gin.WrapF(handler.SaveUserAssetData))
	api.GET("/proxy-image", gin.WrapF(handler.ProxyImage))
	api.GET("/prompts", middleware.OptionalAuth, gin.WrapF(handler.Prompts))
	api.GET("/assets", middleware.OptionalAuth, gin.WrapF(handler.Assets))
	api.POST("/admin/login", gin.WrapF(handler.AdminLogin))

	admin := api.Group("/admin", middleware.AdminAuth)
	admin.GET("/production/budget-applications", gin.WrapF(handler.AdminBudgetApplications))
	admin.POST("/production/budget-applications/:id/decision", func(c *gin.Context) { handler.DecideProductionProjectBudget(c.Writer, c.Request, c.Param("id")) })
	admin.GET("/users", gin.WrapF(handler.AdminUsers))
	admin.POST("/users", gin.WrapF(handler.AdminSaveUser))
	admin.POST("/users/:id/credits", func(c *gin.Context) {
		handler.AdminAdjustUserCredits(c.Writer, c.Request, c.Param("id"))
	})
	admin.DELETE("/users/:id", func(c *gin.Context) {
		handler.AdminDeleteUser(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/credit-logs", gin.WrapF(handler.AdminCreditLogs))
	admin.POST("/credit-logs", gin.WrapF(handler.AdminSaveCreditLog))
	admin.DELETE("/credit-logs/:id", func(c *gin.Context) {
		handler.AdminDeleteCreditLog(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/ai-logs", gin.WrapF(handler.AdminAICallLogs))
	admin.DELETE("/ai-logs", gin.WrapF(handler.AdminDeleteAICallLogs))
	admin.GET("/settings", gin.WrapF(handler.AdminSettings))
	admin.POST("/settings", gin.WrapF(handler.AdminSaveSettings))
	admin.POST("/settings/channel-models", gin.WrapF(handler.AdminChannelModels))
	admin.POST("/settings/channel-test", gin.WrapF(handler.ProjectModelTaskRequired))
	admin.POST("/workflow-providers/runninghub/inspect", gin.WrapF(handler.AdminRunningHubInspect))
	admin.GET("/comfy-bridges", gin.WrapF(handler.AdminComfyBridges))
	admin.POST("/comfy-bridges", gin.WrapF(handler.AdminComfyBridges))
	admin.POST("/comfy-bridges/inspect", gin.WrapF(handler.ProjectWorkflowInspectionPending))
	admin.DELETE("/comfy-bridges/:id", func(c *gin.Context) { handler.AdminDeleteComfyBridge(c.Writer, c.Request, c.Param("id")) })
	bridge := api.Group("/bridge/comfy")
	bridge.POST("/heartbeat", gin.WrapF(handler.BridgeComfyHeartbeat))
	bridge.GET("/poll", gin.WrapF(handler.ProjectModelTaskRequired))
	bridge.POST("/lease", gin.WrapF(handler.ProjectModelTaskRequired))
	bridge.POST("/result", gin.WrapF(handler.BridgeComfyResult))
	admin.POST("/storage/measure", gin.WrapF(handler.AdminMeasureStorageProvider))
	admin.GET("/prompt-categories", gin.WrapF(handler.AdminPromptCategories))
	admin.POST("/prompt-categories/sync", gin.WrapF(handler.AdminSyncPromptCategories))
	admin.POST("/prompt-categories/sync-all", gin.WrapF(handler.AdminSyncAllPromptCategories))
	admin.GET("/prompts", gin.WrapF(handler.AdminPrompts))
	admin.POST("/prompts", gin.WrapF(handler.AdminSavePrompt))
	admin.POST("/prompts/batch-delete", gin.WrapF(handler.AdminDeletePrompts))
	admin.DELETE("/prompts/:id", func(c *gin.Context) {
		handler.AdminDeletePrompt(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/assets", gin.WrapF(handler.AdminAssets))
	admin.POST("/assets", gin.WrapF(handler.AdminSaveAsset))
	admin.DELETE("/assets/:id", func(c *gin.Context) {
		handler.AdminDeleteAsset(c.Writer, c.Request, c.Param("id"))
	})

	router.NoRoute(middleware.NotFoundJSON)

	return router
}
