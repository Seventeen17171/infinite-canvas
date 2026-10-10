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
	for _, status := range []model.UserStatus{model.UserStatusActive, model.UserStatusBan} {
		for _, role := range []model.UserRole{model.UserRoleAdmin, model.UserRoleUser, model.UserRoleGuest} {
			for _, assign := range []bool{false, true} {
				user := model.User{Role: role, Status: status, CanCreateProjects: false, CanAssignProjects: assign}
				public := model.PublicUser(user)
				canCreate := status == model.UserStatusActive && (role == model.UserRoleAdmin || role == model.UserRoleUser)
				canAssign := status == model.UserStatusActive && (role == model.UserRoleAdmin || role == model.UserRoleUser && assign)
				if public.CanCreateProjects != canCreate || public.CanAssignProjects != canAssign {
					t.Fatalf("wrong effective permission for %+v", user)
				}
			}
		}
	}
}
