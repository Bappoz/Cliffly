// A deliberately illustrated fixture with explicit, synthetic depth.
// This is not an image of the user's room and never pretends to be camera input.
export function drawDemo(canvas, time = 0) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.save(); ctx.scale(w / 640, h / 480);
  ctx.fillStyle = '#d4c7ab'; ctx.fillRect(0, 0, 640, 480);
  const shape = (color, x, y, width, height) => { ctx.fillStyle = color; ctx.fillRect(x, y, width, height); };
  shape('#c1b08c',0,320,640,160);
  ctx.strokeStyle='#ae9a73';ctx.lineWidth=2;
  for(let i=0;i<9;i++){ctx.beginPath();ctx.moveTo(320,320);ctx.lineTo(i*100-80,480);ctx.stroke();}
  for(let y=348;y<480;y+=30){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(640,y);ctx.stroke();}
  shape('#778567',42,40,212,225); shape('#f3e8d2',50,48,196,208); shape('#9fc2c4',60,58,176,188);
  shape('#dce9d5',60,163,176,83);shape('#698758',60,206,176,40);
  shape('#eadbc0',141,48,10,208);shape('#eadbc0',50,147,196,10);
  shape('#9b724d',430,60,154,247); shape('#493e32',439,69,136,231);
  for(let row=0;row<3;row++){for(let i=0;i<7;i++){shape(['#6a866b','#ad7258','#d0b174','#749a9f'][i%4],446+i*17,82+row*70,12,45-(i%3)*6);}shape('#b08b60',439,129+row*70,136,8);}
  shape('#806343',148,281,292,26);shape('#624c35',164,307,16,115);shape('#624c35',408,307,16,115);
  shape('#404c43',247,195,113,80);shape('#95b1a0',254,202,99,66);shape('#404c43',299,275,10,8);shape('#404c43',278,281,52,4);
  shape('#ded3b5',217,280,48,4);shape('#d0a86e',378,259,19,23);
  shape('#55724f',304,328,96,65);shape('#3a5239',312,339,80,48);shape('#3e4938',317,392,12,63);shape('#3e4938',375,392,12,63);
  shape('#a36f4f',62,343,55,49);shape('#6c8550',87,226,6,120);
  ctx.fillStyle='#5f834b';for(let i=0;i<7;i++){ctx.beginPath();ctx.ellipse(89+(i%2?18:-18),246+i*12,22,8,i%2?-.6:.6,0,Math.PI*2);ctx.fill();}
  const x=490+Math.sin(time/1800)*25;shape('#c5b477',x,352,55,40);shape('#7b6845',x+7,392,8,32);shape('#7b6845',x+40,392,8,32);
  ctx.restore();
}

export function demoDepth(width, height, time = 0) {
  const depth = new Float32Array(width * height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const u=(x+.5)/width*640, v=(y+.5)/height*480;
    let d=v>320?0.35+(v-320)/160*.55:0.12;
    if(u>430&&u<584&&v>60&&v<307)d=.3;
    if(u>148&&u<440&&v>281&&v<307)d=.68;
    if(((u>164&&u<180)||(u>408&&u<424))&&v>307&&v<422)d=.68;
    if(u>247&&u<360&&v>195&&v<275)d=.65;
    if(u>304&&u<400&&v>328&&v<393)d=.82;
    if(((u>317&&u<329)||(u>375&&u<387))&&v>392&&v<455)d=.82;
    if(u>62&&u<117&&v>225&&v<392)d=.58;
    const moving=490+Math.sin(time/1800)*25;
    if(u>moving&&u<moving+55&&v>352&&v<424)d=.72;
    depth[y*width+x]=d;
  }
  return depth;
}
