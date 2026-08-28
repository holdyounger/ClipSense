from PIL import Image, ImageDraw
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'src', 'renderer')
S = 1024
im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(im)

# Soft rounded background badge
d.rounded_rectangle((32, 32, 992, 992), radius=230, fill=(44, 35, 92, 255), outline=(255, 255, 255, 48), width=12)
# Decorative stars
def star(cx, cy, r, color):
    pts = []
    for i in range(8):
        import math
        a = -math.pi / 2 + i * math.pi / 4
        rr = r if i % 2 == 0 else r * .28
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    d.polygon(pts, fill=color)
star(190, 250, 48, (255, 221, 112, 255))
star(845, 245, 34, (125, 225, 255, 255))

# Shadow
d.ellipse((180, 850, 850, 960), fill=(20, 14, 55, 130))
# Little feet
d.rounded_rectangle((300, 825, 430, 935), radius=48, fill=(255, 190, 105, 255), outline=(55, 35, 85, 255), width=18)
d.rounded_rectangle((600, 825, 730, 935), radius=48, fill=(255, 190, 105, 255), outline=(55, 35, 85, 255), width=18)
# Arms behind body
d.rounded_rectangle((145, 500, 285, 650), radius=65, fill=(255, 190, 105, 255), outline=(55, 35, 85, 255), width=18)
d.rounded_rectangle((739, 500, 879, 650), radius=65, fill=(255, 190, 105, 255), outline=(55, 35, 85, 255), width=18)
# Clipboard body
d.rounded_rectangle((190, 180, 834, 850), radius=105, fill=(111, 91, 236, 255), outline=(55, 35, 85, 255), width=24)
# Paper inset
d.rounded_rectangle((255, 330, 769, 790), radius=62, fill=(245, 243, 255, 255), outline=(55, 35, 85, 255), width=16)
# Clip top
d.rounded_rectangle((350, 105, 674, 290), radius=78, fill=(255, 190, 105, 255), outline=(55, 35, 85, 255), width=22)
d.rounded_rectangle((420, 145, 604, 255), radius=40, fill=(111, 91, 236, 255), outline=(55, 35, 85, 255), width=14)
# Paper lines
d.rounded_rectangle((330, 390, 690, 425), radius=18, fill=(188, 178, 250, 255))
d.rounded_rectangle((330, 475, 640, 510), radius=18, fill=(188, 178, 250, 255))
# Face eyes
d.ellipse((370, 545, 430, 625), fill=(55, 35, 85, 255))
d.ellipse((594, 545, 654, 625), fill=(55, 35, 85, 255))
d.ellipse((388, 558, 405, 580), fill=(255, 255, 255, 255))
d.ellipse((612, 558, 629, 580), fill=(255, 255, 255, 255))
# Blush
d.ellipse((310, 635, 380, 670), fill=(255, 137, 165, 180))
d.ellipse((644, 635, 714, 670), fill=(255, 137, 165, 180))
# Smile
d.arc((430, 585, 594, 735), 15, 165, fill=(55, 35, 85, 255), width=18)
# Highlight
d.rounded_rectangle((238, 260, 280, 465), radius=20, fill=(255, 255, 255, 80))

# Downsample with antialiasing
for name, size in [('app-icon.png', 256), ('tray-icon.png', 16), ('tray-icon@2x.png', 32)]:
    out = im.resize((size, size), Image.Resampling.LANCZOS)
    out.save(os.path.join(OUT, name), optimize=True)
    print(f'created {name} ({size}x{size})')
