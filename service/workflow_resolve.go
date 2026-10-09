package service

import (
	"errors"
	"slices"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type ResolvedWorkflow struct {
	Channel    model.ModelChannel
	Entry      model.WorkflowEntry
	OwnerScope string
	OwnerID    string
}

func ResolveWorkflowForUser(user model.AuthUser, ref WorkflowRef) (ResolvedWorkflow, error) {
	return resolveWorkflowForUser(user, ref, true)
}

func resolveWorkflowForUser(user model.AuthUser, ref WorkflowRef, requireEntry bool) (ResolvedWorkflow, error) {
	if strings.TrimSpace(ref.ChannelID) == "" || strings.TrimSpace(ref.WorkflowID) == "" {
		return ResolvedWorkflow{}, errors.New("请选择有效工作流")
	}
	if ref.Scope != "system" {
		return ResolvedWorkflow{}, errors.New("仅允许使用后台配置的工作流渠道")
	}
	settings, err := repository.GetSettings()
	if err != nil {
		return ResolvedWorkflow{}, err
	}
	if requireEntry && user.Role != model.UserRoleAdmin && !slices.Contains(settings.Public.ModelChannel.AvailableWorkflows, workflowBillingName(ref)) {
		return ResolvedWorkflow{}, errors.New("这条工作流未公开")
	}
	channels := settings.Private.Channels
	ownerScope, ownerID := "system", "system"
	for _, channel := range channels {
		if channel.ID != ref.ChannelID || !channel.Enabled {
			continue
		}
		if !isWorkflowChannelProtocol(channel.Protocol) {
			return ResolvedWorkflow{}, errors.New("目标渠道不是工作流渠道")
		}
		if !requireEntry {
			return ResolvedWorkflow{Channel: channel, OwnerScope: ownerScope, OwnerID: ownerID}, nil
		}
		for _, entry := range channel.Workflows {
			if entry.Kind != ref.Kind || entry.WorkflowID != ref.WorkflowID {
				continue
			}
			if entry.Provider != channel.Protocol {
				return ResolvedWorkflow{}, errors.New("工作流来源与渠道协议不匹配")
			}
			if !entry.Enabled {
				return ResolvedWorkflow{}, errors.New("这条工作流已停用")
			}
			if entry.Capability != "image" && entry.Capability != "video" && entry.Capability != "audio" {
				return ResolvedWorkflow{}, errors.New("工作流用途无效")
			}
			if channel.Protocol == "comfyui" {
				if entry.Kind != "workflow" {
					return ResolvedWorkflow{}, errors.New("ComfyUI 只支持 Workflow 类型")
				}
				bridge, err := repository.GetComfyBridge(channel.BridgeID)
				if err != nil || !bridge.Enabled || bridge.OwnerScope != ownerScope || bridge.OwnerID != ownerID {
					return ResolvedWorkflow{}, errors.New("ComfyUI Bridge 不存在或无权使用")
				}
			}
			return ResolvedWorkflow{Channel: channel, Entry: entry, OwnerScope: ownerScope, OwnerID: ownerID}, nil
		}
		return ResolvedWorkflow{}, errors.New("工作流不存在或已删除")
	}
	return ResolvedWorkflow{}, errors.New("工作流渠道不存在或已删除")
}
