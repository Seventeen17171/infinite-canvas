package service

import (
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestProductionProjectRequestBounds(t *testing.T) {
	valid := CreateProductionProjectRequest{Title: "  项目甲  ", Summary: "第一行\n第二行", ProducerID: "user_example", RequestID: "CB6E10FC-2C68-41AC-84C0-1E86676B7B67"}
	request, err := normalizeProductionRequest(valid)
	if err != nil || request.Title != "项目甲" || request.Summary != valid.Summary || request.RequestID != strings.ToLower(valid.RequestID) {
		t.Fatalf("normalization: %+v, %v", request, err)
	}
	for name, change := range map[string]func(*CreateProductionProjectRequest){
		"empty title":          func(r *CreateProductionProjectRequest) { r.Title = "  " },
		"long unicode title":   func(r *CreateProductionProjectRequest) { r.Title = strings.Repeat("画", 81) },
		"title control":        func(r *CreateProductionProjectRequest) { r.Title = "甲\n乙" },
		"long unicode summary": func(r *CreateProductionProjectRequest) { r.Summary = strings.Repeat("画", 501) },
		"summary control":      func(r *CreateProductionProjectRequest) { r.Summary = "甲\x00乙" },
		"request uuid":         func(r *CreateProductionProjectRequest) { r.RequestID = "same-key" },
		"nil uuid":             func(r *CreateProductionProjectRequest) { r.RequestID = "00000000-0000-0000-0000-000000000000" },
		"missing producer":     func(r *CreateProductionProjectRequest) { r.ProducerID = "" },
	} {
		t.Run(name, func(t *testing.T) {
			input := valid
			change(&input)
			if _, err := normalizeProductionRequest(input); err == nil {
				t.Fatal("expected validation failure")
			}
		})
	}
}

func TestProductionProjectEffectivePermissions(t *testing.T) {
	for _, user := range []model.User{
		{Role: model.UserRoleAdmin},
		{Role: model.UserRoleUser},
		{Role: model.UserRoleUser, CanCreateProjects: true},
		{Role: model.UserRoleUser, CanAssignProjects: true},
		{Role: model.UserRoleGuest, CanCreateProjects: true, CanAssignProjects: true},
	} {
		public := model.PublicUser(user)
		if public.CanCreateProjects != (user.Role == model.UserRoleAdmin || user.Role == model.UserRoleUser && user.CanCreateProjects) || public.CanAssignProjects != (user.Role == model.UserRoleAdmin || user.Role == model.UserRoleUser && user.CanAssignProjects) {
			t.Fatalf("wrong effective permission for %+v", user)
		}
	}
}
