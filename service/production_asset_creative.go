package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type SaveProductionAssetCreativeRequest struct {
	Prompt         string `json:"prompt"`
	ModelChannelID string `json:"modelChannelId"`
	ModelName      string `json:"modelName"`
	AspectRatio    string `json:"aspectRatio"`
	Resolution     string `json:"resolution"`
	ImageCount     int    `json:"imageCount"`
	Revision       int64  `json:"revision"`
	RequestID      string `json:"requestId"`
}

func productionCreativeModels(settings model.Settings) []model.ProductionCreativeModel {
	channels := normalizePrivateSetting(settings.Private).Channels
	allowed := filterEnabledModels(settings.Public.ModelChannel.AvailableModels, enabledChannelModels(channels))
	result := make([]model.ProductionCreativeModel, 0)
	seen := map[string]bool{}
	for _, channel := range channels {
		if !channel.Enabled || isWorkflowChannelProtocol(channel.Protocol) || strings.TrimSpace(channel.BaseURL) == "" || strings.TrimSpace(channel.APIKey) == "" {
			continue
		}
		for _, name := range filterEnabledModels(channel.Models, allowed) {
			image := isImageModelName(name)
			if capability, explicit := channel.ModelCapabilities[name]; explicit {
				image = capability == "image"
			}
			key := channel.ID + "\x00" + name
			if !image || seen[key] {
				continue
			}
			seen[key] = true
			result = append(result, model.ProductionCreativeModel{ChannelID: channel.ID, ChannelName: channel.Name, Model: name, Protocol: channel.Protocol})
		}
	}
	return result
}

func productionCreativeScope(tx *repository.ProductionTx, ctx context.Context, projectID, assetID string, lock bool) (model.User, error) {
	actor, err := productionAssetScope(tx, ctx, projectID, lock)
	if err != nil {
		return actor, err
	}
	_, found, err := tx.Asset(projectID, assetID)
	if err == nil && !found {
		err = projectError(http.StatusNotFound, "资产不存在或无权访问")
	}
	return actor, err
}

func GetProductionAssetCreative(ctx context.Context, projectID, assetID string) (model.ProductionAssetCreativeDetail, error) {
	var detail model.ProductionAssetCreativeDetail
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		if _, err := productionCreativeScope(tx, ctx, projectID, assetID, false); err != nil {
			return err
		}
		creative, found, err := tx.AssetCreative(projectID, assetID)
		if err != nil {
			return err
		}
		if !found {
			creative = model.ProductionAssetCreative{ProjectID: projectID, AssetID: assetID, AspectRatio: "auto", Resolution: "auto", ImageCount: 1}
		}
		settings, err := tx.Settings()
		if err != nil {
			return err
		}
		detail = model.ProductionAssetCreativeDetail{Creative: creative, Models: productionCreativeModels(settings)}
		return nil
	})
	return detail, err
}

func validateAssetCreativeRequest(request SaveProductionAssetCreativeRequest) error {
	if !utf8.ValidString(request.Prompt) || utf8.RuneCountInString(request.Prompt) > 8000 || strings.ContainsFunc(request.Prompt, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) {
		return projectError(http.StatusBadRequest, "提示词最多8000字，不能含异常控制字符")
	}
	for _, value := range []struct {
		text  string
		limit int
	}{{request.ModelChannelID, 128}, {request.ModelName, 256}} {
		if !utf8.ValidString(value.text) || utf8.RuneCountInString(value.text) > value.limit || strings.TrimSpace(value.text) != value.text || strings.ContainsFunc(value.text, unicode.IsControl) {
			return projectError(http.StatusBadRequest, "模型引用无效")
		}
	}
	if (request.ModelChannelID == "") != (request.ModelName == "") {
		return projectError(http.StatusBadRequest, "请选择完整的后台模型或清空选择")
	}
	if !slices.Contains([]string{"auto", "1:1", "4:3", "3:4", "16:9", "9:16"}, request.AspectRatio) || !slices.Contains([]string{"auto", "1K", "2K", "4K"}, request.Resolution) || request.ImageCount < 1 || request.ImageCount > 4 {
		return projectError(http.StatusBadRequest, "创意比例、清晰度或张数无效")
	}
	if request.Revision < 0 || request.Revision >= 9007199254740991 {
		return projectError(http.StatusBadRequest, "创意版本无效")
	}
	id, err := uuid.Parse(request.RequestID)
	if err != nil || len(request.RequestID) != 36 || id == uuid.Nil {
		return projectError(http.StatusBadRequest, "requestId必须为UUID")
	}
	return nil
}

func creativeReceipt(record model.ProductionAssetCreativeRequest) model.ProductionAssetCreativeReceipt {
	return model.ProductionAssetCreativeReceipt{ProjectID: record.ProjectID, AssetID: record.AssetID, Revision: record.Revision, UpdatedAt: record.UpdatedAt, RequestID: record.RequestID}
}

func SaveProductionAssetCreative(ctx context.Context, projectID, assetID string, request SaveProductionAssetCreativeRequest) (model.ProductionAssetCreativeReceipt, error) {
	var receipt model.ProductionAssetCreativeReceipt
	if err := validateAssetCreativeRequest(request); err != nil {
		return receipt, err
	}
	request.RequestID = strings.ToLower(request.RequestID)
	encoded, _ := json.Marshal(struct {
		ProjectID, AssetID string
		Request            SaveProductionAssetCreativeRequest
	}{projectID, assetID, request})
	hash := sha256.Sum256(encoded)
	payloadHash := hex.EncodeToString(hash[:])
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, err := productionCreativeScope(tx, ctx, projectID, assetID, true)
		if err != nil {
			return err
		}
		previous, replay, err := tx.AssetCreativeRequest(actor.ID, request.RequestID)
		if err != nil {
			return err
		}
		if replay {
			if previous.PayloadHash != payloadHash {
				return projectError(http.StatusConflict, "此请求编号已用于其他创意或内容")
			}
			receipt = creativeReceipt(previous)
			return nil
		}
		stored, found, err := tx.AssetCreative(projectID, assetID)
		if err != nil {
			return err
		}
		if (found && stored.Revision != request.Revision) || (!found && request.Revision != 0) {
			return projectError(http.StatusConflict, "创意已被更新，请保留草稿并载入最新版本")
		}
		// A retired, unchanged selection must not block free text preparation.
		if request.ModelName != "" && (!found || stored.ModelChannelID != request.ModelChannelID || stored.ModelName != request.ModelName) {
			settings, err := tx.Settings()
			if err != nil {
				return err
			}
			valid := false
			for _, item := range productionCreativeModels(settings) {
				if item.ChannelID == request.ModelChannelID && item.Model == request.ModelName {
					valid = true
					break
				}
			}
			if !valid {
				return projectError(http.StatusBadRequest, "所选后台图片模型已不可用，请刷新后重新选择")
			}
		}
		creative := model.ProductionAssetCreative{ProjectID: projectID, AssetID: assetID, Prompt: request.Prompt, ModelChannelID: request.ModelChannelID, ModelName: request.ModelName, AspectRatio: request.AspectRatio, Resolution: request.Resolution, ImageCount: request.ImageCount, Revision: request.Revision + 1, UpdatedBy: actor.ID, UpdatedAt: now()}
		updated, err := tx.SaveAssetCreative(creative, request.Revision)
		if err != nil {
			return err
		}
		if !updated {
			return projectError(http.StatusConflict, "创意已被更新，请保留草稿并载入最新版本")
		}
		record := model.ProductionAssetCreativeRequest{ActorID: actor.ID, RequestID: request.RequestID, PayloadHash: payloadHash, ProjectID: projectID, AssetID: assetID, Revision: creative.Revision, UpdatedAt: creative.UpdatedAt}
		if err := tx.RecordAssetCreativeRequest(record); err != nil {
			return err
		}
		receipt = creativeReceipt(record)
		return nil
	})
	return receipt, err
}
