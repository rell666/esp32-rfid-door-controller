# DIN-rail support plate for VOANZO ESP32 2-relay board (holes 69 x 43 c-c, top-left missing)
# Mounts on 2x Printables 64242 clips (60x12 top, 2x d3.2 holes 46 mm c-c).
import os
import manifold3d as mf, numpy as np, trimesh
HERE=os.path.dirname(os.path.abspath(__file__))  # outputs go next to this script
from manifold3d import Manifold as M
FN=64
L,W,T=82,60,3.0            # plate: X along rail, Y across rail
HX,HY=69/2,43/2            # board hole half-spacing
holes=[(HX,HY),(-HX,-HY),(HX,-HY),(-HX,HY)]   # top-left (-X,+Y): support only, no board hole
SO_D,SO_H,PILOT=7.0,7.0,2.6          # standoff OD, height above plate, M3 self-tap pilot
CLIP_X=22.0                          # clip centres along rail (+/-)
CLIP_HY=23.0                         # clip screw holes (46 c-c across rail)
CS_D,CS_HOLE=6.6,3.6                 # countersink for M3/3.5 mm flat-head screws

def rbox(l,w,h,r):
    s=mf.CrossSection.square([l-2*r,w-2*r],center=True).offset(r,mf.JoinType.Round,circular_segments=FN)
    return M.extrude(s,h)
plate=rbox(L,W,T,4)
# central window between clips (light + airflow)
plate-=rbox(2*CLIP_X-12-8,W-26,T*3,3).translate([0,0,-T])
for x,y in holes:
    so=M.cylinder(SO_H+T,SO_D/2,SO_D/2,FN).translate([x,y,0])
    fil=M.cylinder(2,SO_D/2+2,SO_D/2,FN).translate([x,y,T])   # base flare
    plate=plate+so+fil
for x,y in holes:
    plate-=M.cylinder(SO_H+T+2,PILOT/2,PILOT/2,FN).translate([x,y,-1])
for sx in(-1,1):
    for sy in(-1,1):
        x,y=sx*CLIP_X,sy*CLIP_HY
        plate-=M.cylinder(T+2,CS_HOLE/2,CS_HOLE/2,FN).translate([x,y,-1])
        d=(CS_D-CS_HOLE)/2   # 90 deg countersink
        plate-=M.cylinder(d+0.01,CS_HOLE/2,CS_D/2,FN).translate([x,y,T-d])
        plate-=M.cylinder(1,CS_D/2,CS_D/2,FN).translate([x,y,T])
# 0.6 mm locating pockets on underside for clip tops (12.4 wide)
for sx in(-1,1):
    plate-=M.cube([12.4,W+2,0.6],True).translate([sx*CLIP_X,0,0.3-0.001])
mesh=plate.to_mesh()
t=trimesh.Trimesh(mesh.vert_properties[:,:3],mesh.tri_verts)
print('watertight',t.is_watertight,'bounds',t.bounds.round(2).tolist(),'vol cm3',round(t.volume/1000,2))
t.export(os.path.join(HERE,'esp32_din_plate.stl'))
# preview with the clips: only if the clip model (Printables 64242, not in
# this repo) has been downloaded next to this script as dins_clip.stl
CLIP=os.path.join(HERE,'dins_clip.stl')
if not os.path.exists(CLIP):
    raise SystemExit('esp32_din_plate.stl written; no dins_clip.stl, so no preview.glb')
clip=trimesh.load(CLIP); clip.apply_translation([-30,-16,-6])  # centre, top face at y=0
R=trimesh.transformations.rotation_matrix
clip.apply_transform(R(np.pi/2,[1,0,0])@np.eye(4)) # Y up -> Z up
clip.apply_transform(R(np.pi/2,[0,0,1]))           # length across rail (Y)
scene=[t]
for sx in(-1,1):
    c=clip.copy(); c.apply_translation([sx*CLIP_X,0,0.6]); c.visual.face_colors=[90,140,220,255]; scene.append(c)
print('clip bounds', [s.bounds.round(1).tolist() for s in scene[1:]])
trimesh.Scene(scene).export(os.path.join(HERE,'preview.glb'))
