package service

import (
	"encoding/binary"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"

	"golang.org/x/image/riff"
	"golang.org/x/image/vp8"
	"golang.org/x/image/vp8l"
	_ "golang.org/x/image/webp"
)

const productionImageMaxPixels = 24000000

func validProductionImageDimensions(width, height int) bool {
	return width > 0 && height > 0 && width <= 8192 && height <= 8192 && int64(width)*int64(height) <= productionImageMaxPixels
}
func validateProductionImage(file *os.File) (string, error) {
	invalid := func() (string, error) {
		return "", projectError(http.StatusUnprocessableEntity, "图片损坏或格式不受支持，请选择静态PNG、JPEG或WebP")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return invalid()
	}
	config, format, err := image.DecodeConfig(file)
	if err != nil || (format != "png" && format != "jpeg" && format != "webp") {
		return invalid()
	}
	if !validProductionImageDimensions(config.Width, config.Height) {
		return "", projectError(http.StatusUnprocessableEntity, "图片边长最多8192像素，总像素最多2400万")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return invalid()
	}
	if format == "png" {
		if err := validateStaticPNG(file); err != nil {
			return invalid()
		}
	}
	if format == "webp" {
		if err := validateStaticWebP(file, config.Width, config.Height); err != nil {
			return invalid()
		}
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return invalid()
	}
	decoded, decodedFormat, err := image.Decode(file)
	if err != nil || decodedFormat != format {
		return invalid()
	}
	bounds := decoded.Bounds()
	if bounds.Dx() != config.Width || bounds.Dy() != config.Height || !validProductionImageDimensions(bounds.Dx(), bounds.Dy()) {
		return invalid()
	}
	return "image/" + format, nil
}

// PNG decompression and CRC validation remain in image/png; this bounded chunk walk only refuses APNG control blocks.
func validateStaticPNG(reader io.Reader) error {
	var signature [8]byte
	if _, err := io.ReadFull(reader, signature[:]); err != nil {
		return err
	}
	for {
		var header [8]byte
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			return err
		}
		length := int64(binary.BigEndian.Uint32(header[:4]))
		if length > ProductionFileMaxBytes {
			return fmt.Errorf("invalid chunk length")
		}
		name := string(header[4:])
		if name == "acTL" || name == "fcTL" || name == "fdAT" {
			return fmt.Errorf("animated PNG")
		}
		if _, err := io.CopyN(io.Discard, reader, length+4); err != nil {
			return err
		}
		if name == "IEND" {
			if length != 0 {
				return fmt.Errorf("invalid IEND")
			}
			return nil
		}
	}
}

// RIFF and image bitstream headers are parsed by the official x/image packages. Check the inner payload before full decode: VP8X dimensions alone are insufficient.
func validateStaticWebP(reader io.Reader, width, height int) error {
	form, chunks, err := riff.NewReader(reader)
	if err != nil || string(form[:]) != "WEBP" {
		return fmt.Errorf("invalid webp")
	}
	images, extended := 0, 0
	for {
		kind, length, chunk, err := chunks.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		switch string(kind[:]) {
		case "ANIM", "ANMF":
			return fmt.Errorf("animated webp")
		case "VP8X":
			extended++
			var flags [10]byte
			if length != 10 || extended > 1 {
				return fmt.Errorf("invalid VP8X")
			}
			if _, err := io.ReadFull(chunk, flags[:]); err != nil {
				return err
			}
			if flags[0]&2 != 0 {
				return fmt.Errorf("animated webp")
			}
		case "VP8 ":
			images++
			decoder := vp8.NewDecoder()
			decoder.Init(chunk, int(length))
			header, err := decoder.DecodeFrameHeader()
			if err != nil {
				return err
			}
			if header.Width != width || header.Height != height || !validProductionImageDimensions(header.Width, header.Height) {
				return fmt.Errorf("webp dimensions mismatch")
			}
		case "VP8L":
			images++
			header, err := vp8l.DecodeConfig(chunk)
			if err != nil {
				return err
			}
			if header.Width != width || header.Height != height || !validProductionImageDimensions(header.Width, header.Height) {
				return fmt.Errorf("webp dimensions mismatch")
			}
		}
		if images > 1 {
			return fmt.Errorf("multiple image payloads")
		}
	}
	if images != 1 {
		return fmt.Errorf("missing image payload")
	}
	return nil
}
