BINARY := firenet
BIN_DIR := bin

.PHONY: build run dev test fe-test fe-build test-e2e vet fmt tidy clean

build:
	docker compose build backend

run:
	docker compose up --build

dev:
	docker compose up -d --build

test:
	go test ./...

fe-test:
	cd frontend && npm test

fe-build:
	cd frontend && npm run build

test-e2e: build
	cd e2e && npx playwright test

vet:
	go vet ./...

fmt:
	gofmt -l -w .

tidy:
	go mod tidy

clean:
	rm -rf $(BIN_DIR)
