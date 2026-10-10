package service

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/repository"
)

type productionCanvasPoint struct {
	X *float64 `json:"x"`
	Y *float64 `json:"y"`
}

type productionCanvasMetadata struct {
	Content  string   `json:"content,omitempty"`
	GroupID  string   `json:"groupId,omitempty"`
	FontSize *float64 `json:"fontSize,omitempty"`
	AssetID  string   `json:"assetId,omitempty"`
	FileID   string   `json:"fileId,omitempty"`
	fields   map[string]json.RawMessage
}

func (m *productionCanvasMetadata) UnmarshalJSON(raw []byte) error {
	type metadata productionCanvasMetadata
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode((*metadata)(m)); err != nil {
		return err
	}
	return json.Unmarshal(raw, &m.fields)
}

type productionCanvasNode struct {
	ID       string                    `json:"id"`
	Type     string                    `json:"type"`
	Title    string                    `json:"title"`
	Position *productionCanvasPoint    `json:"position"`
	Width    float64                   `json:"width"`
	Height   float64                   `json:"height"`
	Metadata *productionCanvasMetadata `json:"metadata,omitempty"`
}

type productionCanvasContent struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Nodes         []productionCanvasNode `json:"nodes"`
	Connections   []struct {
		ID         string `json:"id"`
		FromNodeID string `json:"fromNodeId"`
		ToNodeID   string `json:"toNodeId"`
	} `json:"connections"`
	Viewport *struct {
		X *float64 `json:"x"`
		Y *float64 `json:"y"`
		K *float64 `json:"k"`
	} `json:"viewport"`
	BackgroundMode string `json:"backgroundMode"`
}

func canvasFiniteInRange(value float64, minimum, maximum float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= minimum && value <= maximum
}

func canvasCoordinate(value *float64) bool {
	return value != nil && canvasFiniteInRange(*value, -1000000, 1000000)
}

func canvasElementID(id string) bool {
	return validProductionID(id) && strings.TrimSpace(id) == id
}

func canvasResourceID(id, prefix string) bool {
	parsed, err := uuid.Parse(strings.TrimPrefix(id, prefix))
	return err == nil && parsed != uuid.Nil && id == prefix+parsed.String()
}

func normalizeProductionCanvasContent(raw json.RawMessage) (json.RawMessage, error) {
	invalid := projectError(http.StatusBadRequest, "画布正文格式、节点或连线无效")
	if len(raw) > 2<<20 {
		return nil, projectError(http.StatusRequestEntityTooLarge, "画布正文不能超过2MiB")
	}
	var content productionCanvasContent
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&content); err != nil {
		return nil, invalid
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, invalid
	}
	if content.SchemaVersion != 1 || content.Nodes == nil || content.Connections == nil || len(content.Nodes) > 300 || len(content.Connections) > 600 || content.Viewport == nil {
		return nil, invalid
	}
	if !canvasCoordinate(content.Viewport.X) || !canvasCoordinate(content.Viewport.Y) || content.Viewport.K == nil || !canvasFiniteInRange(*content.Viewport.K, 0.05, 10) {
		return nil, invalid
	}
	if content.BackgroundMode != "dots" && content.BackgroundMode != "lines" && content.BackgroundMode != "blank" {
		return nil, invalid
	}
	nodes := make(map[string]productionCanvasNode, len(content.Nodes))
	images := 0
	for _, node := range content.Nodes {
		if !canvasElementID(node.ID) || (node.Type != "text" && node.Type != "group" && node.Type != "image") || utf8.RuneCountInString(node.Title) > 200 || node.Position == nil || !canvasCoordinate(node.Position.X) || !canvasCoordinate(node.Position.Y) || !canvasFiniteInRange(node.Width, 16, 10000) || !canvasFiniteInRange(node.Height, 16, 10000) {
			return nil, invalid
		}
		if _, exists := nodes[node.ID]; exists {
			return nil, invalid
		}
		if node.Metadata != nil && node.Metadata.FontSize != nil && !canvasFiniteInRange(*node.Metadata.FontSize, 8, 128) {
			return nil, invalid
		}
		if node.Type == "image" {
			images++
			if images > 20 || node.Metadata == nil || !canvasResourceID(node.Metadata.AssetID, "asset-") || !canvasResourceID(node.Metadata.FileID, "file-") {
				return nil, invalid
			}
		}
		if node.Metadata != nil {
			for field := range node.Metadata.fields {
				if node.Type == "image" && field != "assetId" && field != "fileId" && field != "groupId" || node.Type != "image" && (strings.EqualFold(field, "assetId") || strings.EqualFold(field, "fileId")) {
					return nil, invalid
				}
			}
		}
		nodes[node.ID] = node
	}
	for _, node := range content.Nodes {
		seen := map[string]bool{node.ID: true}
		for current := node; current.Metadata != nil && current.Metadata.GroupID != ""; {
			parent, found := nodes[current.Metadata.GroupID]
			if !found || parent.Type != "group" || seen[parent.ID] {
				return nil, invalid
			}
			seen[parent.ID] = true
			current = parent
		}
	}
	edges := make(map[string]bool, len(content.Connections))
	for _, edge := range content.Connections {
		_, from := nodes[edge.FromNodeID]
		_, to := nodes[edge.ToNodeID]
		if !canvasElementID(edge.ID) || edges[edge.ID] || !from || !to || edge.FromNodeID == edge.ToNodeID {
			return nil, invalid
		}
		fromType, toType := nodes[edge.FromNodeID].Type, nodes[edge.ToNodeID].Type
		if fromType == "image" && toType == "group" || fromType == "group" && toType == "image" {
			return nil, invalid
		}
		edges[edge.ID] = true
	}
	return json.Marshal(content)
}

// References inherit the document's authorized project. Only an unchanged node in
// this same document may retain a missing index, so unrelated edits remain saveable.
func validateProductionCanvasReferences(tx *repository.ProductionTx, projectID string, raw, previous json.RawMessage) error {
	var content, old productionCanvasContent
	if err := json.Unmarshal(raw, &content); err != nil {
		return err
	}
	unchanged := make(map[string]productionCanvasNode)
	if len(previous) > 0 && json.Unmarshal(previous, &old) == nil {
		for _, node := range old.Nodes {
			if node.Type == "image" && node.Metadata != nil {
				unchanged[node.ID] = node
			}
		}
	}
	for _, node := range content.Nodes {
		if node.Type != "image" {
			continue
		}
		invalid := projectError(http.StatusUnprocessableEntity, "引用图片不存在或与当前项目资产不匹配，请重新选择项目图片")
		metadata := node.Metadata
		prior, existed := unchanged[node.ID]
		retained := existed && prior.Metadata.AssetID == metadata.AssetID && prior.Metadata.FileID == metadata.FileID
		file, fileFound, err := tx.File(projectID, metadata.FileID)
		if err != nil {
			return err
		}
		if fileFound {
			if file.AssetID != metadata.AssetID {
				return invalid
			}
			if _, err := productionFileView(file); err != nil {
				return invalid
			}
		}
		_, assetFound, err := tx.Asset(projectID, metadata.AssetID)
		if err != nil {
			return err
		}
		if (!fileFound || !assetFound) && !retained {
			return invalid
		}
	}
	return nil
}
