package service

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strings"
	"unicode/utf8"
)

type productionCanvasPoint struct {
	X *float64 `json:"x"`
	Y *float64 `json:"y"`
}

type productionCanvasNode struct {
	ID       string                 `json:"id"`
	Type     string                 `json:"type"`
	Title    string                 `json:"title"`
	Position *productionCanvasPoint `json:"position"`
	Width    float64                `json:"width"`
	Height   float64                `json:"height"`
	Metadata *struct {
		Content  string   `json:"content,omitempty"`
		GroupID  string   `json:"groupId,omitempty"`
		FontSize *float64 `json:"fontSize,omitempty"`
	} `json:"metadata,omitempty"`
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
	for _, node := range content.Nodes {
		if !canvasElementID(node.ID) || (node.Type != "text" && node.Type != "group") || utf8.RuneCountInString(node.Title) > 200 || node.Position == nil || !canvasCoordinate(node.Position.X) || !canvasCoordinate(node.Position.Y) || !canvasFiniteInRange(node.Width, 16, 10000) || !canvasFiniteInRange(node.Height, 16, 10000) {
			return nil, invalid
		}
		if _, exists := nodes[node.ID]; exists {
			return nil, invalid
		}
		if node.Metadata != nil && node.Metadata.FontSize != nil && !canvasFiniteInRange(*node.Metadata.FontSize, 8, 128) {
			return nil, invalid
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
		edges[edge.ID] = true
	}
	return json.Marshal(content)
}
