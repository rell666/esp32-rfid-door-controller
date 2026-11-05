#!/usr/bin/env python3
"""Generates the two-door wiring drawing (SVG) for the README.

Run from the repo root: python3 docs/wiring/gen.py docs/wiring/wiring-two-door.svg
Every coordinate is laid out by hand so wires meet pins exactly; junctions
carry a dot, crossings never do.
"""
import sys

W, H = 2000, 1180
out = []
RED, BLK, GRN, ORA, PUR, GRY, BLU = "#d62728", "#222", "#1f9e3a", "#ff7f0e", "#8e44ad", "#777", "#1f5fbf"


def add(s):
    out.append(s)


def text(x, y, s, size=13, anchor="start", weight="normal", fill="#222", italic=False):
    st = ' font-style="italic"' if italic else ""
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    add(f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}" font-weight="{weight}" fill="{fill}"{st}>{s}</text>')


def box(x, y, w, h, title=None, sub=None, fill="#f7f7f7", stroke="#333", rx=6, sw=1.6):
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')
    if title:
        text(x + w / 2, y + 20, title, 14, "middle", "bold")
    if sub:
        text(x + w / 2, y + 37, sub, 11.5, "middle", fill="#555")


def wire(pts, color, width=2.6, dash=None):
    d = " ".join(f"{x},{y}" for x, y in pts)
    da = f' stroke-dasharray="{dash}"' if dash else ""
    if color == "white":  # a white wire: dark casing, white core
        add(f'<polyline points="{d}" fill="none" stroke="#333" stroke-width="{width + 2.4}" stroke-linejoin="round"/>')
        add(f'<polyline points="{d}" fill="none" stroke="#fff" stroke-width="{width}" stroke-linejoin="round"{da}/>')
    else:
        add(f'<polyline points="{d}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linejoin="round"{da}/>')


def dot(x, y, color=BLK):
    add(f'<circle cx="{x}" cy="{y}" r="4.5" fill="{color}"/>')


def pin(x, y, label, side, color="#333"):
    """A terminal on a box edge; side = 'l' or 'r' (label goes inside the box)."""
    add(f'<circle cx="{x}" cy="{y}" r="4" fill="#fff" stroke="{color}" stroke-width="1.8"/>')
    if side == "l":
        text(x + 9, y + 4.5, label, 12)
    elif side == "r":
        text(x - 9, y + 4.5, label, 12, "end")
    elif side == "b":
        text(x, y - 10, label, 12, "middle")
    elif side == "t":
        text(x, y + 20, label, 12, "middle")


def ground(x, y, color=BLK):
    """Ground symbol hanging below (x, y)."""
    wire([(x, y), (x, y + 12)], color, 2)
    for i, half in enumerate((11, 7, 3)):
        yy = y + 12 + i * 4.5
        add(f'<line x1="{x - half}" y1="{yy}" x2="{x + half}" y2="{yy}" stroke="{color}" stroke-width="2"/>')


def flag(x, y, label, color, direction="r"):
    """Net label: a flag at the end of a wire; direction it points to."""
    w = 10 + 8.2 * len(label)
    if direction == "r":
        p = [(x, y), (x + 10, y - 11), (x + 10 + w, y - 11), (x + 10 + w, y + 11), (x + 10, y + 11)]
        tx, anc = x + 14, "start"
    elif direction == "l":
        p = [(x, y), (x - 10, y - 11), (x - 10 - w, y - 11), (x - 10 - w, y + 11), (x - 10, y + 11)]
        tx, anc = x - 14, "end"
    else:  # 'u': flag above the wire end
        add(f'<rect x="{x - w / 2}" y="{y - 26}" width="{w}" height="22" rx="3" fill="#fff" stroke="{color}" stroke-width="1.8"/>')
        text(x, y - 10, label, 12, "middle", "bold", color)
        return
    d = " ".join(f"{a},{b}" for a, b in p)
    add(f'<polygon points="{d}" fill="#fff" stroke="{color}" stroke-width="1.8"/>')
    text(tx, y + 4.5, label, 12, anc, "bold", color)


def fuse(x, y, label, horizontal=True):
    if horizontal:
        add(f'<rect x="{x}" y="{y - 8}" width="44" height="16" fill="#fff" stroke="#333" stroke-width="1.6"/>')
        add(f'<line x1="{x}" y1="{y}" x2="{x + 44}" y2="{y}" stroke="#333" stroke-width="1.2"/>')
        text(x + 22, y - 14, label, 12, "middle", "bold")
    else:
        add(f'<rect x="{x - 8}" y="{y}" width="16" height="44" fill="#fff" stroke="#333" stroke-width="1.6"/>')
        add(f'<line x1="{x}" y1="{y}" x2="{x}" y2="{y + 44}" stroke="#333" stroke-width="1.2"/>')
        text(x + 16, y + 26, label, 12, "start", "bold")


def contact_nc(x, y, label, sub):
    """Normally-closed contact on a horizontal wire, from x to x+60."""
    add(f'<line x1="{x}" y1="{y}" x2="{x + 18}" y2="{y}" stroke="{RED}" stroke-width="2.6"/>')
    add(f'<line x1="{x + 42}" y1="{y}" x2="{x + 60}" y2="{y}" stroke="{RED}" stroke-width="2.6"/>')
    add(f'<line x1="{x + 18}" y1="{y}" x2="{x + 44}" y2="{y + 8}" stroke="#222" stroke-width="2.2"/>')  # blade resting on the far contact
    add(f'<line x1="{x + 42}" y1="{y}" x2="{x + 42}" y2="{y + 12}" stroke="#222" stroke-width="2"/>')
    text(x + 30, y - 12, label, 12, "middle", "bold")
    text(x + 30, y + 30, sub, 11, "middle", fill="#555")


def pushbutton_v(x, y1, y2, label, sub):
    """Normally-open push button on a vertical wire between y1 and y2."""
    m = (y1 + y2) / 2
    wire([(x, y1), (x, m - 8)], GRY, 2.4)
    wire([(x, m + 8), (x, y2)], GRY, 2.4)
    add(f'<line x1="{x - 12}" y1="{m - 8}" x2="{x - 12}" y2="{m + 8}" stroke="#222" stroke-width="2.4"/>')  # blade, open
    add(f'<line x1="{x - 12}" y1="{m}" x2="{x - 26}" y2="{m}" stroke="#222" stroke-width="2"/>')  # plunger
    add(f'<line x1="{x - 26}" y1="{m - 6}" x2="{x - 26}" y2="{m + 6}" stroke="#222" stroke-width="2"/>')
    text(x + 12, m - 4, label, 12, weight="bold")
    text(x + 12, m + 12, sub, 11, fill="#555")


def diode_v(x, y_top, y_bot, label):
    """Diode on a vertical wire, cathode (band) at the top."""
    m = (y_top + y_bot) / 2
    wire([(x, y_top), (x, m - 10)], BLK, 2)
    wire([(x, m + 10), (x, y_bot)], BLK, 2)
    add(f'<polygon points="{x - 10},{m + 10} {x + 10},{m + 10} {x},{m - 8}" fill="#222"/>')
    add(f'<line x1="{x - 10}" y1="{m - 9}" x2="{x + 10}" y2="{m - 9}" stroke="#222" stroke-width="3"/>')
    text(x - 14, m + 4, label, 11.5, "end", "bold")


def nc_stub(x, y, label):
    """Unconnected reader wire: a short stub ending in a cross."""
    add(f'<line x1="{x}" y1="{y}" x2="{x - 26}" y2="{y}" stroke="#999" stroke-width="2" stroke-dasharray="4 3"/>')
    add(f'<path d="M{x - 31},{y - 5} l10,10 M{x - 31},{y + 5} l10,-10" stroke="#999" stroke-width="2"/>')
    text(x - 38, y + 4, label, 11, "end", fill="#888", italic=True)


add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif">')
add(f'<rect width="{W}" height="{H}" fill="#fff"/>')
add(f'<rect x="10" y="10" width="{W - 20}" height="{H - 20}" fill="none" stroke="#333" stroke-width="2"/>')
text(40, 50, "Ironframe RFID — two-door wiring", 24, weight="bold")
text(40, 74, "VOANZO ESP32 2-relay board, two Wiegand readers, level shifter, two maglocks on NO (firmware 1.7 preset)", 14, fill="#444")

# ---------------------------------------------------------------- power
box(40, 110, 170, 130, "12 V DC PSU", "readers + board + locks")
pin(210, 175, "+12 V", "r", RED)
pin(210, 215, "0 V", "r", BLK)
wire([(214, 175), (250, 175)], RED)
dot(250, 175, RED)
wire([(250, 175), (290, 175)], RED)
fuse(290, 175, "F1 1 A")
wire([(334, 175), (370, 175)], RED)
flag(370, 175, "+12V LOGIC", RED)
text(290, 205, "controller + readers", 11, fill="#555")
wire([(214, 215), (232, 215), (232, 232)], BLK)
ground(232, 232)

# lock supply chain, all in series: F2, fire-alarm contact, break-glass
wire([(250, 175), (250, 340), (270, 340)], RED)
fuse(270, 340, "")
text(292, 372, "F2 (locks)", 12, "middle", "bold")
wire([(314, 340), (355, 340)], RED)
contact_nc(355, 340, "Fire-alarm relay", "opens on alarm")
wire([(415, 340), (455, 340)], RED)
contact_nc(455, 340, "Break-glass", "green, NC")
wire([(515, 340), (525, 340)], RED)
flag(525, 340, "+12V LOCKS", RED)
text(60, 412, "The maglock supply goes through the fire-alarm relay and the", 12, fill="#333")
text(60, 430, "break-glass unit, so the doors release whatever the controller does.", 12, fill="#333")

# ---------------------------------------------------------------- relay board
BX, BY, BW, BH = 640, 110, 440, 460
box(BX, BY, BW, BH, "VOANZO ESP32 2-channel relay board", "Amazon UK B0DS6SB1XB · ESP32-WROOM-32E", fill="#eef4fb")
pin(BX, 210, "DC IN +", "l", RED)
pin(BX, 260, "DC IN −", "l", BLK)
wire([(BX - 4, 210), (BX - 40, 210)], RED)
flag(BX - 40, 210, "+12V LOGIC", RED, "l")
wire([(BX - 4, 260), (BX - 40, 260), (BX - 40, 276)], BLK)
ground(BX - 40, 276)
add(f'<rect x="{BX + 150}" y="{BY + 70}" width="160" height="110" rx="4" fill="#fff" stroke="#555" stroke-width="1.4"/>')
text(BX + 230, BY + 120, "ESP32-WROOM-32E", 13, "middle", "bold")
text(BX + 230, BY + 140, "LED GPIO23 · BOOT GPIO0", 11, "middle", fill="#555")
add(f'<rect x="{BX + 40}" y="{BY + 190}" width="110" height="80" rx="4" fill="#fff" stroke="#555" stroke-width="1.2" stroke-dasharray="5 3"/>')
text(BX + 95, BY + 212, "P4 serial", 12, "middle", "bold")
text(BX + 95, BY + 230, "IO0 GND GND", 11, "middle", fill="#555")
text(BX + 95, BY + 245, "RX TX 5V", 11, "middle", fill="#555")
text(BX + 95, BY + 261, "flashing only", 11, "middle", fill="#555", italic=True)
for i, (kx, name, gp) in enumerate(((BX + 30, "Relay 1", "GPIO16"), (BX + 230, "Relay 2", "GPIO17"))):
    add(f'<rect x="{kx}" y="{BY + 300}" width="170" height="90" rx="4" fill="#fff" stroke="#555" stroke-width="1.4"/>')
    text(kx + 85, BY + 330, f"{name} — {gp}", 13, "middle", "bold")
    text(kx + 85, BY + 350, "10 A, active high", 11, "middle", fill="#555")
    text(kx + 85, BY + 368, "door " + str(i + 1), 11, "middle", fill="#555")
# relay terminals on the bottom edge
RT = BY + BH  # 570
K = {"NO1": BX + 50, "COM1": BX + 115, "NC1": BX + 180, "NO2": BX + 250, "COM2": BX + 315, "NC2": BX + 380}
for name, x in K.items():
    pin(x, RT, name[:-1], "b", RED if name.startswith("COM") else "#333")
# ribbon header on the right edge
add(f'<rect x="{BX + BW - 46}" y="{BY + 120}" width="40" height="250" rx="3" fill="#333"/>')
for r in range(10):
    for c in range(2):
        add(f'<circle cx="{BX + BW - 36 + c * 20}" cy="{BY + 135 + r * 24.5}" r="4" fill="#d4af37"/>')
text(BX + BW - 56, BY + 250, "2×10 GPIO header", 12, "end", "bold")
text(BX + BW - 56, BY + 267, "(board edge)", 11, "end", fill="#555")

# ---------------------------------------------------------------- ribbon + breakout
CX, CY, CW, CH = 1170, 110, 200, 500
add(f'<polygon points="{BX + BW},{BY + 130} {CX},{CY + 115} {CX},{CY + 395} {BX + BW},{BY + 360}" fill="#bbb" stroke="#888" stroke-width="1"/>')
for i in range(1, 10):
    y0 = BY + 130 + i * 23
    y1 = CY + 115 + i * 28
    add(f'<line x1="{BX + BW}" y1="{y0}" x2="{CX}" y2="{y1}" stroke="#999" stroke-width="0.8"/>')
text((BX + BW + CX) / 2, BY + 410, "20-way", 12, "middle", "bold")
text((BX + BW + CX) / 2, BY + 425, "ribbon", 12, "middle", "bold")
text((BX + BW + CX) / 2, BY + 441, "B07SC19QC3", 11, "middle", fill="#555")
box(CX, CY, CW, CH, "IDC20 breakout", "B07V4LLMSP · DIN rail", fill="#f3f7ee")
BRK = [("G34", 240, "row 3"), ("G35", 270, "row 4"), ("G32", 300, "row 4"), ("G33", 330, "row 5"),
       ("3V3", 370, "row 1"), ("GND", 400, "row 1"), ("5V", 440, "row 10"), ("GND", 470, "row 10"), ("G13", 510, "row 8")]
for name, y, row in BRK:
    pin(CX + CW, y, name, "r")
    text(CX + 14, y + 4, row, 11, fill="#777")
text(CX + 14, 160, "header row shown left;", 11, fill="#555")
text(CX + 14, 175, "terminal numbers depend", 11, fill="#555")
text(CX + 14, 190, "on the ribbon's way round:", 11, fill="#555")
text(CX + 14, 205, "check with a meter", 11, fill="#555", weight="bold")
text(CX + 14, 560, "never connect: EN, G12,", 11, fill=RED, weight="bold")
text(CX + 14, 575, "SD2, SD3, CMD, SVP, SVN", 11, fill=RED, weight="bold")

# ---------------------------------------------------------------- level shifter
SX, SY, SW, SH = 1460, 165, 180, 260
box(SX, SY, SW, SH, "Level shifter", "B07RY15XMJ · BSS138 4-ch", fill="#fdf3e7")
for name, y in (("LV1", 240), ("LV2", 270), ("LV3", 300), ("LV4", 330), ("LV", 370), ("GND", 400)):
    pin(SX, y, name, "l")
for name, y in (("HV1", 240), ("HV2", 270), ("HV3", 300), ("HV4", 330), ("HV", 370), ("GND", 400)):
    pin(SX + SW, y, name, "r")
text(SX + 10, SY + 57, "3.3 V side", 11, fill="#555", italic=True)
text(SX + SW - 10, SY + 57, "5 V side", 11, "end", fill="#555", italic=True)
# breakout -> shifter, straight across
wire([(CX + CW + 4, 240), (SX - 4, 240)], GRN)
wire([(CX + CW + 4, 270), (SX - 4, 270)], "white")
wire([(CX + CW + 4, 300), (SX - 4, 300)], GRN)
wire([(CX + CW + 4, 330), (SX - 4, 330)], "white")
wire([(CX + CW + 4, 370), (SX - 4, 370)], PUR)
wire([(CX + CW + 4, 400), (SX - 4, 400)], BLK)
# 5 V round the bottom of the shifter to HV
wire([(CX + CW + 4, 440), (SX + SW + 30, 440), (SX + SW + 30, 370), (SX + SW + 4, 370)], ORA)
# exit button between GND and G13
wire([(CX + CW + 4, 470), (1420, 470)], BLK)
wire([(CX + CW + 4, 510), (1420, 510)], GRY)
pushbutton_v(1420, 470, 510, "Exit button, door 1", "normally open; to GND, never 5 V")

# ---------------------------------------------------------------- readers
RX, RW = 1740, 180



# reader 1: D0/D1 straight from HV1/HV2
box(RX, 120, RW, 230, "Reader 1 — door 1", "Wiegand · B0HG1Z4PRL", fill="#f0f0f5")
for lab, y, col in (("LED", 190, "#333"), ("BEEP", 212, "#333"), ("D0 green", 240, GRN), ("D1 white", 270, "#333")):
    pin(RX, y, lab, "l", col)
pin(RX + RW, 300, "+12V red", "r", RED)
pin(RX + RW, 330, "GND black", "r", BLK)
wire([(SX + SW + 4, 240), (RX - 4, 240)], GRN)
wire([(SX + SW + 4, 270), (RX - 4, 270)], "white")
# reader 2: D0/D1 from HV3/HV4, jogging down
box(RX, 420, RW, 230, "Reader 2 — door 2", "Wiegand · B0HG1Z4PRL", fill="#f0f0f5")
for lab, y, col in (("LED", 490, "#333"), ("BEEP", 512, "#333"), ("D0 green", 540, GRN), ("D1 white", 570, "#333")):
    pin(RX, y, lab, "l", col)
pin(RX + RW, 600, "+12V red", "r", RED)
pin(RX + RW, 630, "GND black", "r", BLK)
wire([(SX + SW + 4, 300), (1700, 300), (1700, 540), (RX - 4, 540)], GRN)
wire([(SX + SW + 4, 330), (1685, 330), (1685, 570), (RX - 4, 570)], "white")
# LED / BEEP not connected
for y in (190, 212, 490, 512):
    add(f'<line x1="{RX - 4}" y1="{y}" x2="{RX - 22}" y2="{y}" stroke="#999" stroke-width="2" stroke-dasharray="4 3"/>')
    add(f'<path d="M{RX - 28},{y - 5} l10,10 M{RX - 28},{y + 5} l10,-10" stroke="#999" stroke-width="2"/>')
text(RX - 34, 140, "LED / BEEP not connected", 11, "end", fill="#888", italic=True)
text(RX - 34, 154, "(each needs an NPN / ULN2003 driver)", 11, "end", fill="#888", italic=True)
# reader power by net label, on the right
for y12, yg in ((300, 330), (600, 630)):
    wire([(RX + RW + 4, y12), (RX + RW + 16, y12), (RX + RW + 16, y12 - 26)], RED)
    flag(RX + RW + 16, y12 - 26, "+12V LOGIC", RED, "u")
    wire([(RX + RW + 4, yg), (RX + RW + 16, yg), (RX + RW + 16, yg + 4)], BLK)
    ground(RX + RW + 16, yg + 4)
text(RX + RW / 2, 375, "Set the reader to Wiegand output", 11, "middle", fill="#555")
text(RX + RW / 2, 390, "(master code, see its manual)", 11, "middle", fill="#555")

# ---------------------------------------------------------------- locks
LY = 720
for i, (no, com, nc) in enumerate((("NO1", "COM1", "NC1"), ("NO2", "COM2", "NC2"))):
    xno, xcom, xnc = K[no], K[com], K[nc]
    # COM to the lock supply
    wire([(xcom, RT + 4), (xcom, RT + 60)], RED)
    add(f'<rect x="{xcom - 50}" y="{RT + 60}" width="100" height="22" rx="3" fill="#fff" stroke="{RED}" stroke-width="1.8"/>')
    text(xcom, RT + 76, "+12V LOCKS", 12, "middle", "bold", RED)
    # NC unused
    add(f'<line x1="{xnc}" y1="{RT + 4}" x2="{xnc}" y2="{RT + 22}" stroke="#999" stroke-width="2" stroke-dasharray="4 3"/>')
    text(xnc, RT + 36, "unused", 11, "middle", fill="#888", italic=True)
    # NO straight down to maglock +
    xp = xno
    mx = xp - 30
    add(f'<rect x="{mx}" y="{LY + 80}" width="160" height="90" rx="6" fill="#eee" stroke="#333" stroke-width="1.6"/>')
    text(mx + 95, LY + 112, f"Maglock {i + 1}", 14, "middle", "bold")
    text(mx + 95, LY + 130, "12 V DC", 11, "middle", fill="#555")
    text(mx + 95, LY + 146, f"door {i + 1}", 11, "middle", fill="#555")
    wire([(xno, RT + 4), (xp, LY + 76)], RED)
    pin(xp, LY + 80, "", "t", RED)
    text(xp + 9, LY + 98, "+", 14, weight="bold", fill=RED)
    pin(xp, LY + 170, "", "t", BLK)
    text(xp + 9, LY + 164, "−", 14, weight="bold")
    wire([(xp, LY + 174), (xp, LY + 210)], BLK)
    ground(xp, LY + 210)
    # flyback diode across the coil, band to +: door 1 on the left, door 2 on the right
    xd = xp - 50 if i == 0 else xp + 150
    wire([(xp, LY + 50), (xd, LY + 50)], RED, 2)
    dot(xp, LY + 50, RED)
    diode_v(xd, LY + 50, LY + 195, "")
    wire([(xd, LY + 195), (xp, LY + 195)], BLK, 2)
    dot(xp, LY + 195)
    if i == 0:
        text(xd - 14, LY + 127, "1N4007", 11, "end", "bold")
    else:
        text(xd + 14, LY + 127, "1N4007", 11, weight="bold")
for j, line in enumerate((
        "Diode at the lock, band to +.",
        "Maglock on NO: the relay is ON while the door",
        "is locked. Set each door's “When the relay is on,",
        "the door is” to Locked (the 1.7 default).",
        "A dead or restarting controller releases the door;",
        "NC wiring holds instead (README-IRONFRAME.md, Locks).")):
    text(60, 700 + j * 19, line, 12, fill="#333")

# ---------------------------------------------------------------- notes + legend
NX, NY = 1170, 700
box(NX, NY, 760, 300, None, None, fill="#fff")
text(NX + 16, NY + 26, "Settings (Doors & Readers page)", 14, weight="bold")
notes = [
    "Door 1: relay GPIO16, reader 1 D0 34 / D1 35, exit button GPIO13.",
    "Door 2: relay GPIO17, reader 2 D0 32 / D1 33.",
    "Relay type Active High; Unlock time 3000 ms (3000–5000, prove on the lock).",
    "A fresh esp32wroom board is pre-filled with exactly this: check it, then Save & Reboot.",
    "",
    "Why the level shifter: the readers idle at 5 V; the ESP32 takes 3.6 V at most.",
    "Without it the pins sat at 3.8 V with 0.11 mA flowing into the chip (measured).",
    "GPIO34/35 have no pull-ups of their own: the shifter's 10 kΩ pull-ups hold them.",
    "",
    "Common ground: PSU 0 V, board, shifter and both readers.",
    "Wires that cross without a dot are not connected.",
]
for i, n in enumerate(notes):
    text(NX + 16, NY + 52 + i * 21, n, 12.5, fill="#222")

LX, LYG = 40, 460
text(LX, LYG, "Wire colours", 14, weight="bold")
legend = [(RED, "+12 V"), (BLK, "0 V / GND"), (ORA, "5 V (board → shifter HV)"), (PUR, "3.3 V (board → shifter LV)"),
          (GRN, "Wiegand D0"), ("white", "Wiegand D1"), (GRY, "Exit button")]
for i, (c, lab) in enumerate(legend):
    y = LYG + 24 + i * 22
    wire([(LX, y), (LX + 50, y)], c)
    text(LX + 62, y + 4.5, lab, 12.5)

# title block
TX, TY = 40, 1040
add(f'<rect x="{TX}" y="{TY}" width="{W - 80}" height="110" fill="#fafafa" stroke="#333" stroke-width="1.6"/>')
cols = [("Drawing", "Two-door wiring, VOANZO board"), ("Firmware", "Ironframe RFID 1.7.x, esp32wroom preset"),
        ("Source", "docs/wiring/gen.py (regenerate, never hand-edit)"), ("Date", "2026-10-17")]
cw = (W - 80) / len(cols)
for i, (k, v) in enumerate(cols):
    x = TX + i * cw
    if i:
        add(f'<line x1="{x}" y1="{TY}" x2="{x}" y2="{TY + 110}" stroke="#333" stroke-width="1.2"/>')
    text(x + 16, TY + 34, k, 12, fill="#666")
    text(x + 16, TY + 62, v, 14, weight="bold")
text(TX + 16, TY + 94, "Full rules and reasons: README-IRONFRAME.md (Two doors, Wiring, Locks).", 12, fill="#444")

add("</svg>")
open(sys.argv[1], "w").write("\n".join(out) + "\n")
