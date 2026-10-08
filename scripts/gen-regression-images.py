#!/usr/bin/env python3
"""Gera as imagens (PNG) do dataset de regressão. Chamado por gen-regression-dataset.mjs.

Entrada (stdin): JSON [{ "out": caminho, "lines": [...], "illegible": bool }]
Determinístico: fonte fixa (DejaVu Sans), sem metadados de data, ruído com semente fixa.
"""
import json
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def render(lines, illegible):
    font = ImageFont.truetype(FONT, 22)
    w, line_h = 640, 34
    h = 40 + line_h * len(lines)
    img = Image.new("RGB", (w, h), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        draw.text((24, 20 + i * line_h), line, fill=(20, 20, 20), font=font)
    if illegible:
        # foto tremida + baixa resolução + ruído: ilegível de propósito
        small = img.resize((w // 12, h // 12), Image.BILINEAR)
        img = small.resize((w, h), Image.BILINEAR).filter(ImageFilter.GaussianBlur(6))
        rnd = random.Random(1234)
        px = img.load()
        for _ in range(w * h // 3):
            x, y = rnd.randrange(w), rnd.randrange(h)
            v = rnd.randrange(80, 255)
            px[x, y] = (v, v, v)
    return img


def main():
    specs = json.load(sys.stdin)
    for s in specs:
        render(s["lines"], s.get("illegible", False)).save(s["out"], format="PNG", optimize=False)


if __name__ == "__main__":
    main()
