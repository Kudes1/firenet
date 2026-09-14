FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/firenet ./cmd/firenet

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/firenet /firenet
ENV FIRENET_ADDR=0.0.0.0:8787
EXPOSE 8787
ENTRYPOINT ["/firenet"]
