"""Gera a marca do DZ23 nos tamanhos que o Chrome usa.

O ícone anterior era o do projeto original: candles com um "BUY" verde. Duas coisas erradas — é a marca de outro produto e
promete sinal de compra num assistente que não emite recomendação. A 16 px o "BUY" vira ruído.

A marca: um "Z" desenhado como traço único sobre a cor do painel, com a barra de baixo mais espessa. Formas de 3 traços
sobrevivem a 16 px; texto e detalhe fino não. O traço superior é curto e o inferior longo, o que mantém a leitura mesmo no
tamanho mínimo.

Paleta vem do painel (app.css): --bg #0b0f14, --accent #38d6b0.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(r"C:\Users\lmpra\Documents\tradingview-assistant-chrome-extension-main")
OUT = ROOT / "extension" / "images"

BG = (11, 15, 20, 255)        # --bg
ACCENT = (56, 214, 176, 255)  # --accent
SIZES = (16, 32, 48, 64, 128)
SUPERSAMPLE = 8               # desenha grande e reduz: antialias de graça


def draw_mark(canvas: int) -> Image.Image:
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # fundo: quadrado de cantos arredondados (o Chrome pinta sobre a barra clara e a escura)
    radius = canvas * 0.22
    draw.rounded_rectangle((0, 0, canvas - 1, canvas - 1), radius=radius, fill=BG)

    # margem interna generosa: ícone que encosta na borda parece amador em 16 px
    pad = canvas * 0.24
    left, right = pad, canvas - pad
    top, bottom = pad, canvas - pad

    stroke = max(2, int(canvas * 0.115))

    # barra superior
    draw.line([(left, top), (right, top)], fill=ACCENT, width=stroke)
    # diagonal: do canto superior direito ao inferior esquerdo
    draw.line([(right, top), (left, bottom)], fill=ACCENT, width=stroke)
    # barra inferior, mais espessa: dá peso para baixo, como o "Z" tipográfico
    bottom_width = int(stroke * 1.45)
    draw.line([(left, bottom), (right, bottom)], fill=ACCENT, width=bottom_width)

    return image


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        big = draw_mark(size * SUPERSAMPLE)
        icon = big.resize((size, size), Image.LANCZOS)
        target = OUT / f"dz23_{size}.png"
        icon.save(target, "PNG", optimize=True)
        print(f"{target.name:16} {size}x{size}  {target.stat().st_size} B")


if __name__ == "__main__":
    main()
