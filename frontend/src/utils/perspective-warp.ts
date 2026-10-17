export function buildPerspectiveWarpHtml(rawBase64: string): string {
  const base64 = String(rawBase64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
  return String.raw`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:#141414;color:#fff;font:15px Arial,sans-serif}
body{display:flex;flex-direction:column;overflow:hidden}.note{padding:5px 8px;color:#eee;font-size:11px;line-height:1.25;flex-shrink:0}
.stage{flex:1;min-height:120px;height:100%;width:100%;display:flex;align-items:center;justify-content:center;overflow:hidden}
canvas{display:block;flex-shrink:0;max-width:100%;max-height:100%;width:auto;height:auto;touch-action:none}
.modeRow{display:flex;align-items:center;gap:8px;padding:5px 8px;background:#292929;color:#ddd;font-size:11px;flex-shrink:0}.modeRow label{white-space:nowrap}.modeRow select{flex:1;min-width:0;background:#3b3b3b;color:#fff;border:1px solid #666;border-radius:6px;padding:6px;font-size:11px}.controls{display:flex;gap:5px;padding:5px 6px;background:#202020;flex-shrink:0}
button{flex:1;min-width:0;border:0;border-radius:7px;padding:8px 2px;font-weight:700;font-size:10px;line-height:1.15;color:#fff;background:#3b82f6}
button.secondary{background:#454545}button:disabled{opacity:.55}
</style></head><body>
<div class="note">Drag the blue corners onto the paper edges, then tap Auto-Scan Page or Correct.</div>
<div class="stage"><canvas id="preview"></canvas></div>
<div class="controls"><button class="secondary" id="reset">Reset</button><button class="secondary" id="autoScan">Auto-Scan Page</button><button class="secondary" id="guideToggle">Hide Guides</button><button id="apply">Correct</button></div>
<script>
(function(){
var img=new Image(),canvas=document.getElementById("preview"),ctx=canvas.getContext("2d"),points=[],active=-1,showGuides=true,originalSrc="data:image/jpeg;base64,__BASE64__",guideToggle=document.getElementById("guideToggle");
function fitPreview(){if(!img.naturalWidth||!img.naturalHeight)return;var stage=document.querySelector(".stage"),sw=stage.clientWidth||window.innerWidth,sh=stage.clientHeight||300,scale=Math.min(sw/img.naturalWidth,sh/img.naturalHeight);canvas.style.width=Math.max(1,Math.floor(img.naturalWidth*scale))+"px";canvas.style.height=Math.max(1,Math.floor(img.naturalHeight*scale))+"px";}
img.onload=function(){canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;var w=canvas.width,h=canvas.height,i=Math.max(12,Math.min(w,h)*.035);points=[{x:i,y:i},{x:w-i,y:i},{x:w-i,y:h-i},{x:i,y:h-i}];fitPreview();draw();};
window.addEventListener("resize",fitPreview);
img.onerror=function(){window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:"error",message:"The selected photo could not be opened."}));};
img.src=originalSrc;
function draw(){if(!img.naturalWidth)return;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0);if(showGuides){ctx.save();ctx.strokeStyle="#3b82f6";ctx.lineWidth=Math.max(2,canvas.width*.0015);ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);for(var i=1;i<4;i++)ctx.lineTo(points[i].x,points[i].y);ctx.closePath();ctx.stroke();var r=Math.max(8,canvas.width*.008);points.forEach(function(p,i){ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fillStyle="#2563eb";ctx.fill();ctx.lineWidth=Math.max(2,canvas.width*.0015);ctx.strokeStyle="#fff";ctx.stroke();ctx.fillStyle="#fff";ctx.font="bold "+Math.max(10,canvas.width*.008)+"px Arial";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(String(i+1),p.x,p.y);});ctx.restore();}}
function pointFromEvent(e){var r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height};}
canvas.addEventListener("pointerdown",function(e){var q=pointFromEvent(e),best=Infinity;active=-1;points.forEach(function(p,i){var d=Math.hypot(p.x-q.x,p.y-q.y);if(d<best){best=d;active=i;}});if(best>Math.max(100,canvas.width*.07))active=-1;if(active>=0){canvas.setPointerCapture(e.pointerId);e.preventDefault();}});
canvas.addEventListener("pointermove",function(e){if(active<0)return;var q=pointFromEvent(e);points[active]={x:Math.max(0,Math.min(canvas.width,q.x)),y:Math.max(0,Math.min(canvas.height,q.y))};draw();e.preventDefault();});
function finish(){active=-1;}canvas.addEventListener("pointerup",finish);canvas.addEventListener("pointercancel",finish);
document.getElementById("reset").onclick=function(){var w=canvas.width,h=canvas.height,i=Math.max(12,Math.min(w,h)*.035);points=[{x:i,y:i},{x:w-i,y:i},{x:w-i,y:h-i},{x:i,y:h-i}];draw();};
function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function sourcePoint(u,v,p){var dx1=p[1].x-p[2].x,dx2=p[3].x-p[2].x,dx3=p[0].x-p[1].x+p[2].x-p[3].x,dy1=p[1].y-p[2].y,dy2=p[3].y-p[2].y,dy3=p[0].y-p[1].y+p[2].y-p[3].y,den=dx1*dy2-dx2*dy1,g=0,h=0;if(Math.abs(dx3)>.0001||Math.abs(dy3)>.0001){if(Math.abs(den)<.0001)throw new Error("These corners are invalid. Move them so the paper forms a clear quadrilateral.");g=(dx3*dy2-dx2*dy3)/den;h=(dx1*dy3-dx3*dy1)/den;}var a=p[1].x-p[0].x+g*p[1].x,b=p[3].x-p[0].x+h*p[3].x,c=p[0].x,d=p[1].y-p[0].y+g*p[1].y,e=p[3].y-p[0].y+h*p[3].y,f=p[0].y,z=g*u+h*v+1;if(Math.abs(z)<.0001)throw new Error("These corners are invalid. Adjust the four corners.");return{x:(a*u+b*v+c)/z,y:(d*u+e*v+f)/z};}
function drawTriangle(out,src,dst){var x1=src[0].x,y1=src[0].y,x2=src[1].x,y2=src[1].y,x3=src[2].x,y3=src[2].y,X1=dst[0].x,Y1=dst[0].y,X2=dst[1].x,Y2=dst[1].y,X3=dst[2].x,Y3=dst[2].y,den=x1*(y2-y3)+x2*(y3-y1)+x3*(y1-y2);if(Math.abs(den)<.0001)return;var a=(X1*(y2-y3)+X2*(y3-y1)+X3*(y1-y2))/den,c=(X1*(x3-x2)+X2*(x1-x3)+X3*(x2-x1))/den,e=(X1*(x2*y3-x3*y2)+X2*(x3*y1-x1*y3)+X3*(x1*y2-x2*y1))/den,b=(Y1*(y2-y3)+Y2*(y3-y1)+Y3*(y1-y2))/den,d=(Y1*(x3-x2)+Y2*(x1-x3)+Y3*(x2-x1))/den,f=(Y1*(x2*y3-x3*y2)+Y2*(x3*y1-x1*y3)+Y3*(x1*y2-x2*y1))/den;out.save();out.beginPath();out.moveTo(X1,Y1);out.lineTo(X2,Y2);out.lineTo(X3,Y3);out.closePath();out.clip();out.setTransform(a,b,c,d,e,f);out.drawImage(img,0,0);out.restore();}
function autoDetectPageCorners(){
  var maxSide=320,scale=Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight));
  var sw=Math.max(1,Math.round(img.naturalWidth*scale)),sh=Math.max(1,Math.round(img.naturalHeight*scale));
  var sample=document.createElement("canvas");sample.width=sw;sample.height=sh;
  var sampleCtx=sample.getContext("2d",{willReadFrequently:true});if(!sampleCtx)throw new Error("Automatic page detection is unavailable.");
  sampleCtx.drawImage(img,0,0,sw,sh);
  var pixels=sampleCtx.getImageData(0,0,sw,sh).data,total=sw*sh,gray=new Uint8Array(total),sum=0;
  for(var i=0,j=0;i<pixels.length;i+=4,j++){var value=Math.round(.299*pixels[i]+.587*pixels[i+1]+.114*pixels[i+2]);gray[j]=value;sum+=value;}
  var threshold=Math.max(160,Math.min(225,Math.round(sum/total+18)));
  var visited=new Uint8Array(total),stack=new Int32Array(total),best=null,bestCount=0;
  for(var seed=0;seed<total;seed++){
    if(visited[seed]||gray[seed]<threshold)continue;
    var top=0,bottom=0,minX=sw,maxX=0,minY=sh,maxY=0,count=0,touchesEdge=false;
    stack[bottom++]=seed;visited[seed]=1;
    while(top<bottom){
      var index=stack[top++],x=index%sw,y=Math.floor(index/sw);count++;
      if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;
      if(x===0||y===0||x===sw-1||y===sh-1)touchesEdge=true;
      var neighbours=[x>0?index-1:-1,x<sw-1?index+1:-1,y>0?index-sw:-1,y<sh-1?index+sw:-1];
      for(var k=0;k<4;k++){var next=neighbours[k];if(next>=0&&!visited[next]&&gray[next]>=threshold){visited[next]=1;stack[bottom++]=next;}}
    }
    var boxArea=(maxX-minX+1)*(maxY-minY+1);
    if(!touchesEdge&&count>bestCount&&count>total*.035&&boxArea>total*.08){bestCount=count;best={minX:minX,maxX:maxX,minY:minY,maxY:maxY};}
  }
  if(!best){
    // Fallback for gray, colored, or low-contrast documents: locate strong
    // horizontal/vertical edge intersections near each expected page corner.
    var regions=[
      {x0:2,y0:2,x1:Math.floor(sw*.62),y1:Math.floor(sh*.62),cx:0,cy:0},
      {x0:Math.floor(sw*.38),y0:2,x1:sw-3,y1:Math.floor(sh*.62),cx:sw-1,cy:0},
      {x0:Math.floor(sw*.38),y0:Math.floor(sh*.38),x1:sw-3,y1:sh-3,cx:sw-1,cy:sh-1},
      {x0:2,y0:Math.floor(sh*.38),x1:Math.floor(sw*.62),y1:sh-3,cx:0,cy:sh-1}
    ];
    var fallback=[];
    regions.forEach(function(r){
      var strongest=0,bx=r.cx,by=r.cy;
      for(var yy=Math.max(2,r.y0);yy<Math.min(sh-2,r.y1);yy+=1){
        for(var xx=Math.max(2,r.x0);xx<Math.min(sw-2,r.x1);xx+=1){
          var at=yy*sw+xx;
          var gx=Math.abs(gray[at+1]-gray[at-1])+Math.abs(gray[at+sw+1]-gray[at+sw-1]);
          var gy=Math.abs(gray[at+sw]-gray[at-sw])+Math.abs(gray[at+sw+1]-gray[at-sw+1]);
          var dist=Math.hypot(xx-r.cx,yy-r.cy)/Math.hypot(sw,sh);
          var score=Math.min(gx,gy)*(1.25-.55*dist);
          if(score>strongest){strongest=score;bx=xx;by=yy;}
        }
      }
      fallback.push({x:Math.max(0,Math.min(canvas.width,bx/scale)),y:Math.max(0,Math.min(canvas.height,by/scale))});
    });
    var fallbackArea=0;for(var z=0;z<4;z++)fallbackArea+=fallback[z].x*fallback[(z+1)%4].y-fallback[(z+1)%4].x*fallback[z].y;
    var fallbackWidth=Math.max(fallback[0].x,fallback[1].x,fallback[2].x,fallback[3].x)-Math.min(fallback[0].x,fallback[1].x,fallback[2].x,fallback[3].x);
    var fallbackHeight=Math.max(fallback[0].y,fallback[1].y,fallback[2].y,fallback[3].y)-Math.min(fallback[0].y,fallback[1].y,fallback[2].y,fallback[3].y);
    if(Math.abs(fallbackArea)>canvas.width*canvas.height*.05&&fallbackWidth>canvas.width*.18&&fallbackHeight>canvas.height*.18){points=fallback;draw();return;}
    throw new Error("Could not confidently detect all four page corners. Try Auto-Scan again or drag the blue corners manually.");
  }
  var componentPoints=[];
  for(var y=best.minY;y<=best.maxY;y++)for(var x=best.minX;x<=best.maxX;x++){var idx=y*sw+x;if(gray[idx]>=threshold)componentPoints.push({x:x,y:y});}
  if(componentPoints.length<100)throw new Error("Not enough clear paper area was found. Please adjust the corners manually.");
  var tl=null,tr=null,br=null,bl=null,minSum=Infinity,maxDiff=-Infinity,maxSum=-Infinity,minDiff=Infinity;
  componentPoints.forEach(function(p){var s=p.x+p.y,d=p.x-p.y;if(s<minSum){minSum=s;tl=p;}if(d>maxDiff){maxDiff=d;tr=p;}if(s>maxSum){maxSum=s;br=p;}if(d<minDiff){minDiff=d;bl=p;}});
  var candidate=[tl,tr,br,bl].map(function(p){return{x:Math.max(0,Math.min(canvas.width,p.x/scale)),y:Math.max(0,Math.min(canvas.height,p.y/scale))};});
  var area=0;for(var q=0;q<4;q++)area+=candidate[q].x*candidate[(q+1)%4].y-candidate[(q+1)%4].x*candidate[q].y;
  if(Math.abs(area)<canvas.width*canvas.height*.05)throw new Error("The detected page shape is too small. Please adjust the corners manually.");
  points=candidate;draw();
}
document.getElementById("autoScan").onclick=function(){
  var button=this;button.disabled=true;button.textContent="Detecting…";
  try{autoDetectPageCorners();button.textContent="Correcting page…";document.getElementById("apply").click();}
  catch(err){button.disabled=false;button.textContent="Auto-Scan Page";window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:"error",message:String(err&&err.message||err)}));}
};
guideToggle.onclick=function(){showGuides=!showGuides;guideToggle.textContent=showGuides?"Hide Guides":"Show Guides";draw();};document.getElementById("apply").onclick=function(){var btn=this;btn.disabled=true;btn.textContent="Correcting…";try{var top=distance(points[0],points[1]),bottom=distance(points[3],points[2]),left=distance(points[0],points[3]),right=distance(points[1],points[2]),ow=Math.round((top+bottom)/2),oh=Math.round((left+right)/2);if(ow<80||oh<80)throw new Error("The selected paper area is too small. Widen the corners and try again.");var scale=Math.min(1,1600/Math.max(ow,oh));ow=Math.max(1,Math.round(ow*scale));oh=Math.max(1,Math.round(oh*scale));var out=document.createElement("canvas");out.width=ow;out.height=oh;var o=out.getContext("2d"),n=12,grid=[];for(var y=0;y<=n;y++){grid[y]=[];for(var x=0;x<=n;x++)grid[y][x]=sourcePoint(x/n,y/n,points);}for(var gy=0;gy<n;gy++)for(var gx=0;gx<n;gx++){var u=gx/n,v=gy/n,u1=(gx+1)/n,v1=(gy+1)/n,s00=grid[gy][gx],s10=grid[gy][gx+1],s11=grid[gy+1][gx+1],s01=grid[gy+1][gx],d00={x:u*ow,y:v*oh},d10={x:u1*ow,y:v*oh},d11={x:u1*ow,y:v1*oh},d01={x:u*ow,y:v1*oh};drawTriangle(o,[s00,s10,s11],[d00,d10,d11]);drawTriangle(o,[s00,s11,s01],[d00,d11,d01]);}var data=out.toDataURL("image/jpeg",.96);if(!data||data.length<1000)throw new Error("The corrected image could not be created. Please try again.");window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:"done",dataUrl:data}));}catch(err){btn.disabled=false;btn.textContent="Correct perspective";window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:"error",message:String(err&&err.message||err)}));}};
})();
</script></body></html>`.replace("__BASE64__", base64);
}
