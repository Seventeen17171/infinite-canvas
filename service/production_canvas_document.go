package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"
)

type CreateProductionCanvasDocumentRequest struct {
	Title     string          `json:"title"`
	Content   json.RawMessage `json:"content"`
	RequestID string          `json:"requestId"`
}

type SaveProductionCanvasDocumentRequest struct {
	Title     string          `json:"title"`
	Content   json.RawMessage `json:"content"`
	Revision  int64           `json:"revision"`
	RequestID string          `json:"requestId"`
}

func normalizeCanvasDocumentWrite(title string, content json.RawMessage, requestID string) (string, json.RawMessage, string, error) {
	title = strings.TrimSpace(title)
	if utf8.RuneCountInString(title) < 1 || utf8.RuneCountInString(title) > 80 || strings.ContainsFunc(title, unicode.IsControl) {
		return "", nil, "", projectError(http.StatusBadRequest, "画布名称需为1–80字且不能含控制字符")
	}
	id, err := uuid.Parse(requestID)
	if err != nil || len(requestID) != 36 || id == uuid.Nil {
		return "", nil, "", projectError(http.StatusBadRequest, "requestId必须为UUID")
	}
	canonical, err := normalizeProductionCanvasContent(content)
	return title, canonical, id.String(), err
}

func canvasDocumentRequestHash(operation, projectID, workspaceID, documentID, title string, revision int64, content json.RawMessage) string {
	encoded, _ := json.Marshal(struct {
		Operation, ProjectID, WorkspaceID, DocumentID, Title string
		Revision                                             int64
		Content                                              json.RawMessage
	}{operation, projectID, workspaceID, documentID, title, revision, content})
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

func canvasDocumentReceipt(request model.CanvasDocumentRequest) model.ProductionCanvasSaveReceipt {
	return model.ProductionCanvasSaveReceipt{ID: request.DocumentID, ProjectID: request.ProjectID, WorkspaceID: request.WorkspaceID, Revision: request.Revision, UpdatedAt: request.UpdatedAt, RequestID: request.RequestID}
}

func productionDocumentScope(tx *repository.ProductionTx, ctx context.Context, projectID, kind string, lock bool) (model.User, model.ProductionWorkspace, error) {
	var empty model.ProductionWorkspace
	if kind != "canvas" {
		return model.User{}, empty, projectError(http.StatusBadRequest, "只支持画面创作工作台")
	}
	actor, _, err := productionActor(tx, ctx, "", lock)
	if err != nil {
		return actor, empty, err
	}
	if _, err = productionVisibleProject(tx, projectID, actor.ID, lock); err != nil {
		return actor, empty, err
	}
	workspace, found, err := tx.CanvasWorkspace(projectID)
	if err != nil {
		return actor, workspace, err
	}
	if !found {
		return actor, workspace, projectError(http.StatusNotFound, "工作台不存在")
	}
	return actor, workspace, nil
}

func ListProductionCanvasDocuments(ctx context.Context, projectID, kind string, q model.Query) (model.ProductionCanvasDocumentList, error) {
	var list model.ProductionCanvasDocumentList
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		_, workspace, err := productionDocumentScope(tx, ctx, projectID, kind, false)
		if err != nil {
			return err
		}
		list, err = tx.CanvasDocuments(projectID, workspace.ID, q)
		return err
	})
	return list, err
}

func GetProductionCanvasDocument(ctx context.Context, projectID, kind, id string) (model.ProductionCanvasDocument, error) {
	var document model.ProductionCanvasDocument
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		_, workspace, err := productionDocumentScope(tx, ctx, projectID, kind, false)
		if err != nil {
			return err
		}
		var found bool
		document, found, err = tx.CanvasDocument(projectID, workspace.ID, id)
		if err != nil {
			return err
		}
		if !found {
			return projectError(http.StatusNotFound, "画布文档不存在或无权访问")
		}
		return nil
	})
	return document, err
}

func CreateProductionCanvasDocument(ctx context.Context, projectID, kind string, request CreateProductionCanvasDocumentRequest) (model.ProductionCanvasDocument, error) {
	var document model.ProductionCanvasDocument
	var err error
	request.Title, request.Content, request.RequestID, err = normalizeCanvasDocumentWrite(request.Title, request.Content, request.RequestID)
	if err != nil {
		return document, err
	}
	err = repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, workspace, err := productionDocumentScope(tx, ctx, projectID, kind, true)
		if err != nil {
			return err
		}
		hash := canvasDocumentRequestHash("create", projectID, workspace.ID, "", request.Title, 0, request.Content)
		previous, found, err := tx.CanvasDocumentRequest(actor.ID, request.RequestID)
		if err != nil {
			return err
		}
		if found {
			if previous.PayloadHash != hash {
				return projectError(http.StatusConflict, "此请求编号已用于其他文档或内容")
			}
			document, found, err = tx.CanvasDocument(projectID, workspace.ID, previous.DocumentID)
			if err != nil {
				return err
			}
			if !found {
				return projectError(http.StatusNotFound, "画布文档不存在或无权访问")
			}
			return nil
		}
		if err := validateProductionCanvasReferences(tx, projectID, request.Content, nil); err != nil {
			return err
		}
		timestamp := now()
		document = model.ProductionCanvasDocument{ID: newID("document"), ProjectID: projectID, WorkspaceID: workspace.ID, Title: request.Title, Content: request.Content, Revision: 1, CreatedBy: actor.ID, UpdatedBy: actor.ID, CreatedAt: timestamp, UpdatedAt: timestamp}
		if err := tx.CreateCanvasDocument(document); err != nil {
			return err
		}
		return tx.RecordCanvasDocumentRequest(model.CanvasDocumentRequest{ActorID: actor.ID, RequestID: request.RequestID, PayloadHash: hash, Operation: "create", ProjectID: projectID, WorkspaceID: workspace.ID, DocumentID: document.ID, Revision: 1, UpdatedAt: timestamp})
	})
	return document, err
}

func SaveProductionCanvasDocument(ctx context.Context, projectID, kind, id string, request SaveProductionCanvasDocumentRequest) (model.ProductionCanvasSaveReceipt, error) {
	var receipt model.ProductionCanvasSaveReceipt
	var err error
	request.Title, request.Content, request.RequestID, err = normalizeCanvasDocumentWrite(request.Title, request.Content, request.RequestID)
	if err != nil {
		return receipt, err
	}
	if request.Revision < 1 || request.Revision >= 9007199254740991 {
		return receipt, projectError(http.StatusBadRequest, "文档版本无效")
	}
	err = repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, workspace, err := productionDocumentScope(tx, ctx, projectID, kind, true)
		if err != nil {
			return err
		}
		document, found, err := tx.CanvasDocument(projectID, workspace.ID, id)
		if err != nil {
			return err
		}
		if !found {
			return projectError(http.StatusNotFound, "画布文档不存在或无权访问")
		}
		hash := canvasDocumentRequestHash("save", projectID, workspace.ID, id, request.Title, request.Revision, request.Content)
		previous, found, err := tx.CanvasDocumentRequest(actor.ID, request.RequestID)
		if err != nil {
			return err
		}
		if found {
			if previous.PayloadHash != hash {
				return projectError(http.StatusConflict, "此请求编号已用于其他文档或内容")
			}
			receipt = canvasDocumentReceipt(previous)
			return nil
		}
		if err := validateProductionCanvasReferences(tx, projectID, request.Content, document.Content); err != nil {
			return err
		}
		document.Title, document.Content, document.UpdatedBy, document.UpdatedAt = request.Title, request.Content, actor.ID, now()
		updated, err := tx.SaveCanvasDocument(document, request.Revision)
		if err != nil {
			return err
		}
		if !updated {
			return projectError(http.StatusConflict, "画布已被更新，请保留草稿并载入最新版本")
		}
		record := model.CanvasDocumentRequest{ActorID: actor.ID, RequestID: request.RequestID, PayloadHash: hash, Operation: "save", ProjectID: projectID, WorkspaceID: workspace.ID, DocumentID: id, Revision: request.Revision + 1, UpdatedAt: document.UpdatedAt}
		if err := tx.RecordCanvasDocumentRequest(record); err != nil {
			return err
		}
		receipt = canvasDocumentReceipt(record)
		return nil
	})
	return receipt, err
}
