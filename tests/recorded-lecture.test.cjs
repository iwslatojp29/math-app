const test=require('node:test');
const assert=require('node:assert/strict');
const {Clock,motionMatrix}=require('../automation/renderer/recorded-lecture.js');
class Media extends EventTarget {
  currentTime=0;readyState=1;paused=true;playbackRate=1;muted=false;fail=false;pending=null;
  pause(){this.paused=true;}
  play(){if(this.fail)return Promise.reject(Error('not allowed'));this.paused=false;return this.pending||Promise.resolve();}
}
const units=[{id:'one',start:0,speechEnd:3.2,end:4},{id:'two',start:4,speechEnd:7.2,end:8},{id:'three',start:8,speechEnd:11.2,end:12}];
function fixture(){const media=new Media(),clock=new Clock(media,units);clock.select([0,1,2]);return {clock,media};}
test('pause and resume retain the actual media position, including a long pause',async()=>{
 const {clock,media}=fixture();await clock.play();media.currentTime=2.35;clock.pause();
 for(let i=0;i<500;i++)clock.tick();assert.equal(media.currentTime,2.35);assert.equal(clock.unit.id,'one');
 await clock.play();assert.equal(media.currentTime,2.35);assert(clock.playing);
});
test('speed changes from 1x to 3x preserve position, unit and pitch',async()=>{
 const {clock,media}=fixture();await clock.play();media.currentTime=5.5;clock.position=1;
 for(let rate=1;rate<=3;rate+=.25){clock.speed(rate);assert.equal(media.currentTime,5.5);assert.equal(clock.unit.id,'two');assert.equal(media.playbackRate,rate);assert(media.preservesPitch);}
});
test('a frozen audio clock never advances a diagram despite repeated animation callbacks',async()=>{
 const {clock}=fixture();await clock.play();for(let i=0;i<1000;i++)clock.tick();assert.equal(clock.unit.id,'one');
});
test('real media time determines continuous boundaries, including a small rounding tolerance',async()=>{
 const {clock,media}=fixture();await clock.play();media.currentTime=3.9;clock.tick();assert.equal(clock.unit.id,'one');
 media.currentTime=4.01;clock.tick();assert.equal(clock.unit.id,'two');assert(clock.playing);
});
test('seeking every unit independently cannot select the previous unit',async()=>{
 const {clock,media}=fixture();
 for(let p=0;p<3;p++){clock.select([0,1,2],p);media.currentTime=clock.unit.start-.01;await clock.play();clock.tick();assert.equal(clock.position,p);}
});
test('continuous OFF stops at each unit and next-to-listen advances exactly once',async()=>{
 const {clock,media}=fixture();clock.continuous=false;await clock.play();media.currentTime=4;clock.tick();
 assert(!clock.playing);assert(clock.boundary);assert.equal(clock.unit.id,'one');await clock.play();assert.equal(clock.unit.id,'two');assert.equal(media.currentTime,4);
});
test('last unit ends the lecture without requesting a nonexistent next unit',async()=>{
 const {clock,media}=fixture();clock.select([0,1,2],2);await clock.play();media.currentTime=12;clock.tick();assert(clock.finished);assert(!clock.playing);assert.equal(clock.position,2);
 await clock.play();assert.equal(clock.position,0);assert.equal(media.currentTime,0);
});
test('chapter prerequisites jump to the correct audio when selected units are not adjacent',async()=>{
 const {clock,media}=fixture();clock.select([0,2]);await clock.play();media.currentTime=4;clock.tick();assert.equal(clock.unit.id,'three');assert.equal(media.currentTime,8);
});
test('repeat explicitly restarts only the selected unit',async()=>{
 const {clock,media}=fixture();clock.select([0,1,2],1);media.currentTime=6.2;await clock.repeat();assert.equal(media.currentTime,4);assert.equal(clock.unit.id,'two');
});
test('a rejected play promise restores controls and leaves manual learning available',async()=>{
 const {clock,media}=fixture();media.fail=true;await clock.play();assert(!clock.playing);assert.match(clock.message,/もう一度/);clock.move(1);assert.equal(clock.unit.id,'two');
});
test('switching away invalidates pending playback and cannot restart on a late promise',async()=>{
 const {clock,media}=fixture();let resolve;media.pending=new Promise(r=>resolve=r);const started=clock.play();clock.pause();resolve();await started;assert(!clock.playing);assert(media.paused);
});
test('metadata loading applies the latest seek rather than an obsolete problem selection',()=>{
 const {clock,media}=fixture();media.readyState=0;clock.select([0]);clock.select([2]);assert.equal(clock.pendingSeek,8);media.readyState=1;media.dispatchEvent(new Event('loadedmetadata'));assert.equal(media.currentTime,8);assert.equal(clock.pendingSeek,null);
});
test('rotation keeps its center fixed and reaches the stated quarter turn',()=>{
 const matrix=motionMatrix({type:'rotate',cx:10,cy:20,from:0,to:90},1);
 const apply=(x,y)=>[matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]];
 assert.deepEqual(apply(10,20),[10,20]);const point=apply(15,20);
 assert(Math.abs(point[0]-10)<1e-10);assert(Math.abs(point[1]-25)<1e-10);
});
test('reflection preserves points on the fold line and exchanges its two sides',()=>{
 const matrix=motionMatrix({type:'reflect',x1:0,y1:5,x2:20,y2:5},1);
 const apply=(x,y)=>[matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]];
 assert.deepEqual(apply(7,5),[7,5]);assert.deepEqual(apply(7,8),[7,2]);
});
