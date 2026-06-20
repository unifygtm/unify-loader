type RGB = [number, number, number];

type Transform = {
  x: number;
  y: number;
  scale: number;
  rotation: number;
};

type LoaderShape = {
  strokePx: number;
  getTransform: (frame: number) => Transform;
};

const BACKGROUND_HEX = '#faf8f4';
const BASE_RECT_SIZE = 105;
const DPR_LIMIT = 2;

const WHITE: RGB = [1, 1, 1];
const ORANGE: RGB = [254 / 255, 60 / 255, 1 / 255];
const INK: RGB = [36 / 255, 30 / 255, 32 / 255];
const BACKGROUND: RGB = [250 / 255, 248 / 255, 244 / 255];

const INNER_BASE_SCALE = 1;
const OUTER_BASE_SCALE = 1.51;
const INNER_BASE_ROTATION = 270;
const OUTER_BASE_ROTATION = 45;

const INTRO_INNER_START_FRAME = 11;
const INTRO_INNER_SCALE_END_FRAME = 40;
const INTRO_INNER_ROTATION_END_FRAME = 51;
const INTRO_OUTER_START_FRAME = 28;
const INTRO_OUTER_SCALE_END_FRAME = 56;
const INTRO_OUTER_ROTATION_END_FRAME = 67;
const INTRO_MOTION_END_FRAME = Math.max(INTRO_INNER_ROTATION_END_FRAME, INTRO_OUTER_ROTATION_END_FRAME);
const INTRO_HOLD_FRAMES = 15;
const INTRO_TRIM_FRAMES = 10;
const INTRO_SPEED = 1 / 0.7;
const INTRO_TOTAL_FRAMES = Math.ceil((INTRO_MOTION_END_FRAME + INTRO_HOLD_FRAMES - INTRO_TRIM_FRAMES) / INTRO_SPEED);

const BUMP = 0.12;
const PERIOD_FRAMES = 49;
const INNER_MOVE_FRAMES = 21;
const OUTER_MOVE_FRAMES = 35;
const OUTER_OFFSET_FRAMES = 8;
const NUM_SNAPS = 4;
const BREATHE_TOTAL_FRAMES = PERIOD_FRAMES * NUM_SNAPS;
const STROKE_WIDTH = 1;

const INNER_EASING = [0.89, 0, 0.11, 1] as const;
const OUTER_EASING = [0.2, 0, 0.11, 1] as const;

const FPS = 30;
const ECHO_COUNT = 50;
const ECHO_TIME_SECONDS = -0.002;
const ECHO_STEP_FRAMES = ECHO_TIME_SECONDS * FPS;
const ECHO_DECAY = 0.93;
const FLOATS_PER_INSTANCE = 8;
const INSTANCES_PER_SHAPE = 1 + ECHO_COUNT;

const RECT_VERT = `#version 300 es
in vec2 a_pos;
in vec4 a_mat01;
in vec2 a_mat2;
in float a_opacity;
in float a_unused;

uniform vec2 u_scale;

out float v_opacity;
out vec2 v_uv;

void main() {
  vec2 world = vec2(
    a_mat01.x * a_pos.x + a_mat01.z * a_pos.y + a_mat2.x,
    a_mat01.y * a_pos.x + a_mat01.w * a_pos.y + a_mat2.y
  );
  gl_Position = vec4(world.x * u_scale.x, -world.y * u_scale.y, 0.0, 1.0);
  v_opacity = a_opacity;
  v_uv = a_pos + 0.5;
}`;

const RECT_FRAG = `#version 300 es
precision mediump float;

in float v_opacity;
in vec2 v_uv;

uniform vec3 u_fillColor;
uniform float u_stroke;

out vec4 fragColor;

void main() {
  vec2 edge = abs(v_uv - 0.5);
  bool inStroke = edge.x > 0.5 - u_stroke || edge.y > 0.5 - u_stroke;
  if (inStroke) {
    fragColor = vec4(0.0, 0.0, 0.0, v_opacity);
    return;
  }
  fragColor = vec4(u_fillColor * v_opacity, v_opacity);
}`;

const TRITONE_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;

void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = a_pos * 0.5 + 0.5;
}`;

const TRITONE_FRAG = `#version 300 es
precision mediump float;

in vec2 v_uv;

uniform sampler2D u_acc;
uniform vec3 u_shadows;
uniform vec3 u_midtones;
uniform vec3 u_highlights;

out vec4 fragColor;

void main() {
  vec4 src = texture(u_acc, v_uv);
  float alpha = clamp(src.a, 0.0, 1.0);
  if (alpha < 0.001) {
    fragColor = vec4(0.0);
    return;
  }

  if (max(max(src.r, src.g), src.b) < 0.001) {
    fragColor = vec4(0.0, 0.0, 0.0, alpha);
    return;
  }

  float lum = clamp(dot(src.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  vec3 mapped = lum < 0.5
    ? mix(u_shadows, u_midtones, lum * 2.0)
    : mix(u_midtones, u_highlights, (lum - 0.5) * 2.0);
  fragColor = vec4(mapped, alpha);
}`;

const canvasElement = document.getElementById('loaderCanvas') as HTMLCanvasElement | null;
if (!canvasElement) throw new Error('Missing #loaderCanvas');
const canvas = canvasElement;

let rectSize = BASE_RECT_SIZE;
let frame = 0;
let lastTime = 0;
let rafId = 0;

function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;

  let u = t;
  for (let i = 0; i < 10; i++) {
    const u2 = u * u;
    const u3 = u2 * u;
    const inv = 1 - u;
    const inv2 = inv * inv;
    const bx = 3 * inv2 * u * x1 + 3 * inv * u2 * x2 + u3;
    const dbx = 3 * inv2 * x1 + 6 * inv * u * (x2 - x1) + 3 * u2 * (1 - x2);
    if (Math.abs(dbx) < 1e-10) break;
    u = Math.max(0, Math.min(1, u - (bx - t) / dbx));
  }

  const inv = 1 - u;
  return 3 * inv * inv * u * y1 + 3 * inv * u * u * y2 + u * u * u;
}

function applyEase(t: number, easing: readonly [number, number, number, number]): number {
  return cubicBezier(easing[0], easing[1], easing[2], easing[3], t);
}

function introInnerTransform(sampleFrame: number): Transform {
  const f = Math.min(INTRO_TRIM_FRAMES + sampleFrame * INTRO_SPEED, INTRO_MOTION_END_FRAME);
  let scale = 0;
  if (f >= INTRO_INNER_SCALE_END_FRAME) {
    scale = INNER_BASE_SCALE;
  } else if (f > INTRO_INNER_START_FRAME) {
    const t = (f - INTRO_INNER_START_FRAME) / (INTRO_INNER_SCALE_END_FRAME - INTRO_INNER_START_FRAME);
    scale = applyEase(t, INNER_EASING) * INNER_BASE_SCALE;
  }

  let rotation = 0;
  if (f >= INTRO_INNER_ROTATION_END_FRAME) {
    rotation = INNER_BASE_ROTATION - 180;
  } else if (f > INTRO_INNER_START_FRAME) {
    const t = (f - INTRO_INNER_START_FRAME) / (INTRO_INNER_ROTATION_END_FRAME - INTRO_INNER_START_FRAME);
    rotation = applyEase(t, INNER_EASING) * (INNER_BASE_ROTATION - 180);
  }

  return {x: 0, y: 0, scale, rotation: rotation + 180};
}

function introOuterTransform(sampleFrame: number): Transform {
  const f = Math.min(INTRO_TRIM_FRAMES + sampleFrame * INTRO_SPEED, INTRO_MOTION_END_FRAME);
  let scale = 0;
  if (f >= INTRO_OUTER_SCALE_END_FRAME) {
    scale = OUTER_BASE_SCALE;
  } else if (f > INTRO_OUTER_START_FRAME) {
    const t = (f - INTRO_OUTER_START_FRAME) / (INTRO_OUTER_SCALE_END_FRAME - INTRO_OUTER_START_FRAME);
    scale = applyEase(t, OUTER_EASING) * OUTER_BASE_SCALE;
  }

  let rotation = 0;
  if (f >= INTRO_OUTER_ROTATION_END_FRAME) {
    rotation = OUTER_BASE_ROTATION;
  } else if (f > INTRO_OUTER_START_FRAME) {
    const t = (f - INTRO_OUTER_START_FRAME) / (INTRO_OUTER_ROTATION_END_FRAME - INTRO_OUTER_START_FRAME);
    rotation = applyEase(t, OUTER_EASING) * OUTER_BASE_ROTATION;
  }

  return {x: 0, y: 0, scale, rotation};
}

function breatheTransform(
  sampleFrame: number,
  baseScale: number,
  baseRotation: number,
  offsetFrames: number,
  moveFrames: number,
  easing: readonly [number, number, number, number]
): Transform {
  const loopFrame = (((sampleFrame - offsetFrames) % BREATHE_TOTAL_FRAMES) + BREATHE_TOTAL_FRAMES) % BREATHE_TOTAL_FRAMES;
  const snapIndex = Math.floor(loopFrame / PERIOD_FRAMES);
  const snapFrame = loopFrame % PERIOD_FRAMES;
  const progress = snapFrame < moveFrames
    ? applyEase(Math.min(1, snapFrame / (moveFrames - 1)), easing)
    : 1;
  const rotation = baseRotation + (snapIndex + progress) * 90;
  const scaleMult = snapIndex % 2 === 0 ? 1 + progress * BUMP : 1 + (1 - progress) * BUMP;
  return {x: 0, y: 0, scale: baseScale * scaleMult, rotation};
}

function outerTransform(sampleFrame: number): Transform {
  if (sampleFrame < INTRO_TOTAL_FRAMES) return introOuterTransform(sampleFrame);
  return breatheTransform(sampleFrame - INTRO_TOTAL_FRAMES, OUTER_BASE_SCALE, OUTER_BASE_ROTATION, OUTER_OFFSET_FRAMES, OUTER_MOVE_FRAMES, OUTER_EASING);
}

function innerTransform(sampleFrame: number): Transform {
  if (sampleFrame < INTRO_TOTAL_FRAMES) return introInnerTransform(sampleFrame);
  return breatheTransform(sampleFrame - INTRO_TOTAL_FRAMES, INNER_BASE_SCALE, INNER_BASE_ROTATION, 0, INNER_MOVE_FRAMES, INNER_EASING);
}

const shapes: LoaderShape[] = [
  {strokePx: STROKE_WIDTH / OUTER_BASE_SCALE, getTransform: outerTransform},
  {strokePx: STROKE_WIDTH, getTransform: innerTransform},
];

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'Shader compile failed');
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Unable to create WebGL program');
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'Program link failed');
  }
  return program;
}

function uniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new Error(`Missing uniform ${name}`);
  return location;
}

function writeAffine(
  out: Float32Array,
  offset: number,
  transform: Transform,
  width: number,
  height: number
): void {
  const rad = transform.rotation * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sw = transform.scale * width;
  const sh = transform.scale * height;
  out[offset] = cos * sw;
  out[offset + 1] = sin * sw;
  out[offset + 2] = -sin * sh;
  out[offset + 3] = cos * sh;
  out[offset + 4] = transform.x;
  out[offset + 5] = transform.y;
}

class LoaderRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly rectProgram: WebGLProgram;
  private readonly tritoneProgram: WebGLProgram;
  private readonly rectVao: WebGLVertexArrayObject;
  private readonly triVao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly accFramebuffer: WebGLFramebuffer;
  private readonly accTexture: WebGLTexture;
  private readonly instances = new Float32Array(INSTANCES_PER_SHAPE * FLOATS_PER_INSTANCE);
  private width = 1;
  private height = 1;

  private readonly rectScaleLoc: WebGLUniformLocation;
  private readonly rectFillColorLoc: WebGLUniformLocation;
  private readonly rectStrokeLoc: WebGLUniformLocation;
  private readonly tritoneAccLoc: WebGLUniformLocation;
  private readonly tritoneShadowsLoc: WebGLUniformLocation;
  private readonly tritoneMidtonesLoc: WebGLUniformLocation;
  private readonly tritoneHighlightsLoc: WebGLUniformLocation;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {antialias: true});
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;

    this.rectProgram = linkProgram(gl, RECT_VERT, RECT_FRAG);
    this.tritoneProgram = linkProgram(gl, TRITONE_VERT, TRITONE_FRAG);
    this.rectScaleLoc = uniform(gl, this.rectProgram, 'u_scale');
    this.rectFillColorLoc = uniform(gl, this.rectProgram, 'u_fillColor');
    this.rectStrokeLoc = uniform(gl, this.rectProgram, 'u_stroke');
    this.tritoneAccLoc = uniform(gl, this.tritoneProgram, 'u_acc');
    this.tritoneShadowsLoc = uniform(gl, this.tritoneProgram, 'u_shadows');
    this.tritoneMidtonesLoc = uniform(gl, this.tritoneProgram, 'u_midtones');
    this.tritoneHighlightsLoc = uniform(gl, this.tritoneProgram, 'u_highlights');

    const quadVertices = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);
    const quadIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const quadBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    this.instanceBuffer = gl.createBuffer()!;

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

    this.rectVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.rectVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    const rectPositionLoc = gl.getAttribLocation(this.rectProgram, 'a_pos');
    gl.enableVertexAttribArray(rectPositionLoc);
    gl.vertexAttribPointer(rectPositionLoc, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const stride = FLOATS_PER_INSTANCE * 4;
    const mat01Loc = gl.getAttribLocation(this.rectProgram, 'a_mat01');
    gl.enableVertexAttribArray(mat01Loc);
    gl.vertexAttribPointer(mat01Loc, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(mat01Loc, 1);
    const mat2Loc = gl.getAttribLocation(this.rectProgram, 'a_mat2');
    gl.enableVertexAttribArray(mat2Loc);
    gl.vertexAttribPointer(mat2Loc, 2, gl.FLOAT, false, stride, 4 * 4);
    gl.vertexAttribDivisor(mat2Loc, 1);
    const opacityLoc = gl.getAttribLocation(this.rectProgram, 'a_opacity');
    gl.enableVertexAttribArray(opacityLoc);
    gl.vertexAttribPointer(opacityLoc, 1, gl.FLOAT, false, stride, 6 * 4);
    gl.vertexAttribDivisor(opacityLoc, 1);
    const unusedLoc = gl.getAttribLocation(this.rectProgram, 'a_unused');
    gl.enableVertexAttribArray(unusedLoc);
    gl.vertexAttribPointer(unusedLoc, 1, gl.FLOAT, false, stride, 7 * 4);
    gl.vertexAttribDivisor(unusedLoc, 1);
    gl.bindVertexArray(null);

    const triVertices = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
    const triBuffer = gl.createBuffer();
    const triIndexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, triBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, triVertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

    this.triVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.triVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, triBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triIndexBuffer);
    const triPositionLoc = gl.getAttribLocation(this.tritoneProgram, 'a_pos');
    gl.enableVertexAttribArray(triPositionLoc);
    gl.vertexAttribPointer(triPositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.accTexture = gl.createTexture()!;
    this.accFramebuffer = gl.createFramebuffer()!;
    gl.clearColor(0, 0, 0, 0);
  }

  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.accTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.accTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  render(animationFrame: number, shapeSize: number, loaderShapes: LoaderShape[]): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT);

    for (const shape of loaderShapes) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accFramebuffer);
      gl.viewport(0, 0, this.width, this.height);
      gl.disable(gl.BLEND);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const count = this.buildShapeInstances(shape, animationFrame, shapeSize);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.rectProgram);
      gl.uniform2f(this.rectScaleLoc, 2 / this.width, 2 / this.height);
      gl.uniform3f(this.rectFillColorLoc, WHITE[0], WHITE[1], WHITE[2]);
      gl.uniform1f(this.rectStrokeLoc, shape.strokePx / shapeSize);
      gl.bindVertexArray(this.rectVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.instances.subarray(0, count * FLOATS_PER_INSTANCE), gl.DYNAMIC_DRAW);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
      gl.bindVertexArray(null);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.tritoneProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.accTexture);
      gl.uniform1i(this.tritoneAccLoc, 0);
      gl.uniform3f(this.tritoneShadowsLoc, INK[0], INK[1], INK[2]);
      gl.uniform3f(this.tritoneMidtonesLoc, ORANGE[0], ORANGE[1], ORANGE[2]);
      gl.uniform3f(this.tritoneHighlightsLoc, BACKGROUND[0], BACKGROUND[1], BACKGROUND[2]);
      gl.bindVertexArray(this.triVao);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
    }
  }

  private buildShapeInstances(shape: LoaderShape, animationFrame: number, shapeSize: number): number {
    let offset = 0;
    writeAffine(this.instances, offset, shape.getTransform(animationFrame), shapeSize, shapeSize);
    offset += 6;
    this.instances[offset++] = 1;
    this.instances[offset++] = 0;

    for (let echoIndex = ECHO_COUNT - 1; echoIndex >= 0; echoIndex--) {
      const echoAge = (ECHO_COUNT - echoIndex) * -ECHO_STEP_FRAMES;
      const echoFrame = animationFrame - echoAge;
      writeAffine(this.instances, offset, shape.getTransform(echoFrame), shapeSize, shapeSize);
      offset += 6;
      this.instances[offset++] = Math.pow(ECHO_DECAY, ECHO_COUNT - echoIndex);
      this.instances[offset++] = 0;
    }

    return offset / FLOATS_PER_INSTANCE;
  }
}

const renderer = new LoaderRenderer(canvas);

function resize(): void {
  const rect = canvas.getBoundingClientRect();
  const scale = Math.max(1, Math.min(DPR_LIMIT, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  renderer.resize(width, height);

  const viewportMin = Math.min(rect.width, rect.height);
  rectSize = Math.max(82, Math.min(BASE_RECT_SIZE, viewportMin * 0.42)) * scale;
}

function render(now: number): void {
  rafId = requestAnimationFrame(render);
  if (document.visibilityState === 'hidden') {
    lastTime = now;
    return;
  }

  const deltaMs = lastTime ? now - lastTime : 1000 / FPS;
  lastTime = now;
  frame += deltaMs * FPS / 1000;
  renderer.render(frame, rectSize, shapes);
}

resize();
window.addEventListener('resize', resize, {passive: true});
rafId = requestAnimationFrame(render);

window.addEventListener('pagehide', () => {
  if (rafId) cancelAnimationFrame(rafId);
}, {once: true});

document.documentElement.style.background = BACKGROUND_HEX;
