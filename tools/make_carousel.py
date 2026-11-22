# -*- coding: utf-8 -*-
"""Build the 5-frame README carousel (PNG frames + ping-pong GIF).

Usage: python tools/make_carousel.py <repo-root>
Assets: docs/showcase/{demo-chat.png,scene.jpg,avatar.jpg}
Out:    docs/showcase/carousel/01..05.png + carousel.gif
"""
import os, sys, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
SHOW = os.path.join(ROOT, "docs", "showcase")
OUT = os.path.join(SHOW, "carousel")
os.makedirs(OUT, exist_ok=True)

W, H = 1600, 1000
BG = (10, 12, 17)
CARD = (18, 21, 28)
LINE = (44, 49, 62)
TEXT = (238, 240, 245)
MUTED = (146, 155, 172)
ACCENT = (110, 168, 255)
GOLD = (255, 198, 92)

F_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
F_REG = "C:/Windows/Fonts/msyh.ttc"
F_MONO = "C:/Windows/Fonts/consola.ttf"

def font(path, size):
    try: return ImageFont.truetype(path, size)
    except Exception: return ImageFont.load_default()

def rr(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

def window(img, box, title):
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    sh = Image.new("RGBA", (x1-x0+40, y1-y0+40), (0,0,0,0))
    ImageDraw.Draw(sh).rounded_rectangle((20,20,x1-x0+20,y1-y0+20), 18, fill=(0,0,0,120))
    sh = sh.filter(ImageFilter.GaussianBlur(18))
    img.alpha_composite(sh, (x0-20, y0-20))
    rr(d, box, 16, fill=CARD, outline=LINE, width=1)
    d.rectangle((x0+1, y0+1, x1-1, y0+44), fill=(23,27,35))
    for i,c in enumerate([(255,95,86),(255,189,46),(39,201,63)]):
        d.ellipse((x0+18+i*22, y0+16, x0+30+i*22, y0+28), fill=c)
    d.text((x0+100, y0+14), title, font=font(F_REG,18), fill=MUTED)
    return (x0+1, y0+45, x1-1, y1-1)

def badge(img, xy, text, color=ACCENT, fg=(8,14,26)):
    d = ImageDraw.Draw(img)
    f = font(F_BOLD, 18)
    tw = d.textlength(text, font=f)
    x,y = xy
    rr(d, (x, y, x+tw+34, y+36), 18, fill=color)
    d.text((x+17, y+7), text, font=f, fill=fg)

def fit(im, w, h):
    sc = max(w/im.width, h/im.height)
    im = im.resize((int(im.width*sc)+1, int(im.height*sc)+1), Image.LANCZOS)
    l = (im.width-w)//2; t = (im.height-h)//2
    return im.crop((l,t,l+w,t+h))

def base_canvas():
    img = Image.new("RGBA", (W,H), BG)
    d = ImageDraw.Draw(img)
    for y in range(H):
        k = y/H
        d.line([(0,y),(W,y)], fill=(int(10+8*k), int(12+10*k), int(17+16*k)))
    # soft accent glow
    glow = Image.new("RGBA",(W,H),(0,0,0,0))
    ImageDraw.Draw(glow).ellipse((-300,-400,900,500), fill=(60,100,180,26))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(120)))
    return img

def caption(img, idx, title, en, sub, sub_en):
    d = ImageDraw.Draw(img)
    d.text((70, 816), f"{idx:02d} / 05", font=font(F_MONO, 24), fill=ACCENT)
    d.text((70, 846), title, font=font(F_BOLD, 42), fill=TEXT)
    d.text((70, 896), en, font=font(F_BOLD, 24), fill=ACCENT)
    d.text((72, 930), sub, font=font(F_REG, 21), fill=MUTED)
    d.text((72, 958), sub_en, font=font(F_REG, 18), fill=(120,130,148))

def frame1():
    img = base_canvas()
    box = (120, 60, 1480, 800)
    inner = window(img, box, "SillyTavern  ·  对话时自动生图")
    w, h = inner[2]-inner[0], inner[3]-inner[1]
    raw = Image.open(os.path.join(SHOW,"demo-chat.png")).convert("RGB").crop((0, 60, 1280, 900))
    sc = min(w/raw.width, h/raw.height)
    shot = raw.resize((int(raw.width*sc), int(raw.height*sc)), Image.LANCZOS)
    ox = inner[0] + (w-shot.width)//2; oy = inner[1] + (h-shot.height)//2
    img.paste(shot, (ox, oy))
    badge(img, (inner[0]+18, inner[1]+18), "每轮回复自动配 scene + closeup", ACCENT)
    caption(img, 1, "对话时自动生图", "In-chat illustrations", "回复一结束，两张不同角度的插图自动出现，提示词不露在聊天里。", "A wide scene and a close-up appear after each reply; prompt text stays hidden.")
    return img

def frame2():
    img = base_canvas()
    box = (120, 60, 1480, 800)
    inner = window(img, box, "SillyTavern  ·  角色卡")
    d = ImageDraw.Draw(img)
    av = Image.open(os.path.join(SHOW,"avatar.jpg")).convert("RGB")
    av = fit(av, 320, 320)
    mask = Image.new("L",(320,320),0); ImageDraw.Draw(mask).rounded_rectangle((0,0,319,319),28,fill=255)
    img.paste(av, (inner[0]+60, inner[1]+80), mask)
    d = ImageDraw.Draw(img)
    d.text((inner[0]+420, inner[1]+95), "角色卡示例", font=font(F_BOLD,52), fill=TEXT)
    d.text((inner[0]+420, inner[1]+170), "银发 · 温柔 · 图书馆管理员", font=font(F_REG,26), fill=MUTED)
    for i,(k,v) in enumerate([("头像","自动更新"),("标签","角色绑定"),("一致性","跨镜头保持")]):
        y = inner[1]+245+i*90
        rr(d,(inner[0]+420,y,inner[0]+1130,y+64),12,fill=(25,29,38),outline=LINE)
        d.text((inner[0]+442,y+17),k,font=font(F_REG,22),fill=MUTED)
        d.text((inner[0]+560,y+17),v,font=font(F_BOLD,22),fill=TEXT)
    badge(img,(inner[0]+420, inner[1]+540), "新头像写入角色卡，旧图自动备份", GOLD)
    caption(img, 2, "角色卡自动更新", "Character-card avatars", "生成的形象直接替换角色卡头像，跨聊天保持一致。", "The generated portrait replaces the card avatar; old ones are backed up and the character stays consistent.")
    return img

def frame3():
    img = base_canvas()
    box = (120, 60, 1480, 800)
    inner = window(img, box, "SillyTavern  ·  自动生成背景")
    w, h = inner[2]-inner[0], inner[3]-inner[1]
    bg = fit(Image.open(os.path.join(SHOW,"scene.jpg")).convert("RGB"), w, h)
    img.paste(bg, (inner[0], inner[1]))
    d = ImageDraw.Draw(img)
    # chat bubbles over background
    bx, by = inner[0]+60, inner[1]+h-300
    rr(d,(bx,by,bx+620,by+92),18,fill=(12,15,22,225),outline=(70,78,96))
    d.text((bx+24,by+18),"窗外那棵银杏已经全黄了。",font=font(F_REG,26),fill=TEXT)
    rr(d,(bx+220,by+120,bx+840,by+212),18,fill=(48,82,150,235))
    d.text((bx+244,by+138),"这个背景是实时生成的吗？",font=font(F_REG,26),fill=(240,245,255))
    badge(img,(inner[0]+w-520, inner[1]+40), "场景变化时才换图，旧图自动清理", ACCENT)
    caption(img, 3, "自动生成背景", "Generated backgrounds", "主模型先判断场景有没有变，变了才出图，聊天背景跟着剧情走。", "The main model checks whether the scene changed; only then is a new background drawn.")
    return img

def frame4():
    img = base_canvas()
    box = (120, 60, 1480, 800)
    inner = window(img, box, "SillyTavern  ·  右侧角色栏")
    d = ImageDraw.Draw(img)
    rr(d,(inner[0],inner[1],inner[0]+920,inner[3]),0,fill=(15,18,25))
    d.text((inner[0]+50, inner[1]+80),"把右侧角色栏拖出来，挑人开聊。",font=font(F_BOLD,34),fill=TEXT)
    d.text((inner[0]+50, inner[1]+140),"常用角色固定在右侧，点一下就能切换。",font=font(F_REG,24),fill=MUTED)
    # drawer
    dx0 = inner[0]+920; dx1 = inner[2]
    rr(d,(dx0,inner[1],dx1,inner[3]),0,fill=(22,26,34))
    d.text((dx0+24, inner[1]+24),"角色",font=font(F_BOLD,24),fill=TEXT)
    names = ["角色一","角色二","角色三","Assistant"]
    for i,n in enumerate(names):
        y = inner[1]+90+i*140
        rr(d,(dx0+20,y,dx1-20,y+118),14,fill=(30,35,46),outline=LINE)
        d.ellipse((dx0+36,y+24,dx0+106,y+94),fill=(60,70,92))
        d.text((dx0+122,y+30),n,font=font(F_BOLD,24),fill=TEXT)
        d.text((dx0+122,y+66),"点按切换",font=font(F_REG,18),fill=MUTED)
    badge(img,(inner[0]+50, inner[1]+250), "固定 / 拖拽 / 一键切换", ACCENT)
    caption(img, 4, "拖出右侧角色栏", "Right-side character drawer", "常驻右侧的角色抽屉，不用反复进菜单。", "Pin frequently used characters, switch with one click, drag it out of the way.")
    return img

def frame5():
    img = base_canvas()
    box = (120, 60, 1480, 800)
    inner = window(img, box, "SillyTavern  ·  自定义生图模型")
    d = ImageDraw.Draw(img)
    x = inner[0]+70; y = inner[1]+60
    d.text((x,y),"出图模型",font=font(F_BOLD,30),fill=TEXT)
    rows = [("模型","Anima Turbo v1.1（动漫向）"),("工作流","Anima_Turbo.json"),("步数 / CFG","10 / 1.0"),("采样器","euler · simple"),("尺寸","832 × 1216"),("后端","本地 ComfyUI · 127.0.0.1:8188")]
    for i,(k,v) in enumerate(rows):
        yy = y+70+i*88
        rr(d,(x,yy,x+900,yy+64),12,fill=(24,28,37),outline=LINE)
        d.text((x+22,yy+18),k,font=font(F_REG,22),fill=MUTED)
        d.text((x+300,yy+18),v,font=font(F_BOLD,22),fill=TEXT)
    rr(d,(x+930,y+70,x+1230,y+134),12,fill=ACCENT)
    d.text((x+980,y+88),"应用设置",font=font(F_BOLD,24),fill=(8,14,26))
    d.text((x,y+590),"也可以换成 SDXL / Krea 2 / 云端 API；每段聊天单独记住设置。",font=font(F_REG,20),fill=MUTED)
    badge(img,(x+930,y+170), "全在面板里改", GOLD)
    caption(img, 5, "打开自定义生图模型设置", "Custom image-model settings", "模型、工作流、步数、采样器都在面板里改，不碰配置文件。", "Model, workflow, steps and sampler are editable in the panel, no config files.")
    return img

def main():
    frames = [frame1(), frame2(), frame3(), frame4(), frame5()]
    paths=[]
    for i,f in enumerate(frames,1):
        p=os.path.join(OUT, f"{i:02d}.png")
        f.convert("RGB").save(p, quality=92)
        paths.append(p)
    # ping-pong 1..5..2 for a smooth back-and-forth
    seq = frames + frames[-2:0:-1]
    gif_frames = [f.convert("RGB").resize((1100, 688), Image.LANCZOS) for f in seq]
    gif = os.path.join(OUT, "carousel.gif")
    gif_frames[0].save(gif, save_all=True, append_images=gif_frames[1:], duration=1200, loop=0, optimize=True, disposal=2)
    print("frames", len(frames), "gif", os.path.getsize(gif))

if __name__ == "__main__":
    main()
