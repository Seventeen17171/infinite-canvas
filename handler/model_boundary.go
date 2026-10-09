package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
)

// Model connection details belong exclusively to administrator settings. Do not
// forward a legacy client override to either a provider or the async task log.
func rejectModelConnectionOverrides(body []byte, contentType string) error {
	forbidden := func(key string) bool {
		key = strings.ToLower(strings.NewReplacer("_", "", "-", "", " ", "").Replace(strings.TrimSpace(key)))
		switch key {
		case "apikey", "baseurl", "channel", "channelmode", "userchannelid", "localchannelid", "localchannels", "channeltranslations", "parametertranslation":
			return true
		}
		return false
	}
	denied := errors.New("模型连接参数仅能由后台配置")
	if strings.HasPrefix(contentType, "multipart/form-data") {
		_, params, err := mime.ParseMediaType(contentType)
		if err != nil {
			return err
		}
		reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
		for {
			part, err := reader.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			key := part.FormName()
			part.Close()
			if forbidden(key) {
				return denied
			}
		}
		return nil
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		return err
	}
	for key := range payload {
		if key != "_parameterTranslation" && forbidden(key) {
			return denied
		}
	}
	return nil
}

func rejectRetiredModelConnection(w http.ResponseWriter, r *http.Request) bool {
	if strings.TrimSpace(r.Header.Get(userModelChannelHeader)) != "" {
		Fail(w, "个人模型渠道已停用，请使用后台配置的模型")
		return true
	}
	query, _ := json.Marshal(r.URL.Query())
	if rejectModelConnectionOverrides(query, "application/json") != nil {
		Fail(w, "模型连接参数仅能由后台配置")
		return true
	}
	return false
}
