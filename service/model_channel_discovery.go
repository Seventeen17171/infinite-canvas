package service

import (
	"errors"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"strings"
)

// The client selects an administrator-owned channel, never supplies its address.
func UserAutoDLWorkflows(user model.AuthUser, channelID, workflowID string) (any, error) {
	if user.ID == "" {
		return nil, errors.New("请先登录")
	}
	settings, err := repository.GetSettings()
	if err != nil {
		return nil, err
	}
	for _, channel := range normalizePrivateSetting(settings.Private).Channels {
		if channel.ID != strings.TrimSpace(channelID) || !channel.Enabled || !IsAutoDLChannel(channel) {
			continue
		}
		models := channel.Models
		if user.Role != model.UserRoleAdmin {
			models = filterEnabledModels(models, settings.Public.ModelChannel.AvailableModels)
		}
		workflowID = strings.TrimSpace(workflowID)
		if workflowID != "" {
			if len(filterEnabledModels([]string{workflowID}, models)) == 0 {
				return nil, errors.New("模型未开放")
			}
			return AutoDLWorkflowDetail(channel.BaseURL, workflowID)
		}
		if len(models) == 0 {
			return []AutoDLWorkflow{}, nil
		}
		items, err := AutoDLWorkflows(channel.BaseURL)
		if err != nil {
			return nil, err
		}
		result := []AutoDLWorkflow{}
		for _, item := range items {
			if len(filterEnabledModels([]string{item.UUID}, models)) > 0 {
				result = append(result, item)
			}
		}
		return result, nil
	}
	return nil, errors.New("指定模型渠道不可用")
}
