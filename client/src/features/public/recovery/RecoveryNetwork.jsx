'use strict';

// Velora Recovery Network - the decorative hero visualization.
//
// Meaning, not a particle template: a calm central care core, the people and
// milestones in a patient's recovery arranged on three orbits, the connections
// between them, and small signals travelling along care pathways. No text, no
// data, no patient information, no medical symbols - nothing here comes from an
// API and nothing here is readable as a clinical claim.
//
// The scene is hand-written WebGL, deliberately: a decorative hero does not
// justify shipping a full 3D library (React Three Fiber + three.js cost
// 238.83 kB gzip for this one visual). The whole scene is four draw calls -
// core, glow, lines and two point clouds - with no recursion, no textures and no
// per-frame allocation. The public props are unchanged, so the host decides
// tiers and lifecycle exactly as before.
//
// Ownership of animated state:
//   this module   entrance progress, group scale, camera, hover, pulse travel
//   the host      mount/unmount, tier, reduced motion, frameloop
import { useEffect, useRef } from 'react';

const COLOR = {
  core: [0.867, 0.839, 0.996], // #ddd6fe
  coreGlow: [0.545, 0.361, 0.965], // #8b5cf6
  node: [0.702, 0.616, 0.984], // #b39dfb
  link: [0.545, 0.361, 0.965], // #8b5cf6
  pulse: [0.961, 0.953, 1], // #f5f3ff
};

const FOV_DEGREES = 42;
const FOCAL = 1 / Math.tan((FOV_DEGREES * Math.PI) / 360);

// Deterministic layout: a remount reproduces the same composition instead of a
// jittering new one on every visit.
function seeded(seed) {
  let value = seed;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORBITS = [
  { radius: 1.45, tilt: 0.34, phase: 0.4 },
  { radius: 2.05, tilt: -0.22, phase: 1.7 },
  { radius: 2.65, tilt: 0.12, phase: 3.1 },
];

function buildNetwork(nodeCount) {
  const random = seeded(20261017);
  const nodes = [];
  const segments = [];
  const edges = [];
  const orbits = [];

  ORBITS.forEach((orbit, orbitIndex) => {
    const share = orbitIndex === ORBITS.length - 1
      ? nodeCount - nodes.length
      : Math.round(nodeCount * (orbitIndex === 0 ? 0.34 : 0.33));
    const count = Math.max(3, share);
    const ring = [];
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + orbit.phase + random() * 0.08;
      const y = Math.sin(angle * 2.1 + orbit.phase) * 0.26 + (random() - 0.5) * 0.14;
      const x = Math.cos(angle) * orbit.radius;
      const z = Math.sin(angle) * orbit.radius;
      // Tilt each orbit around X so the composition has depth rather than
      // reading as flat concentric circles.
      const tiltedY = y * Math.cos(orbit.tilt) - z * Math.sin(orbit.tilt);
      const tiltedZ = y * Math.sin(orbit.tilt) + z * Math.cos(orbit.tilt);
      ring.push(nodes.length);
      nodes.push({
        position: [x, tiltedY, tiltedZ],
        orbit: orbitIndex,
        // Inner rings are closer and read slightly larger, which adds depth
        // without a second geometry or a texture.
        scale: orbitIndex === 0 ? 1.15 : orbitIndex === 1 ? 0.95 : 0.8,
      });
    }
    orbits.push(ring);
  });

  // Each orbit is a closed care pathway: node -> next node on the same orbit.
  // Ring paths read as orbits; spokes would collapse into a bright star at the
  // core, which is exactly the "random particle template" look to avoid.
  orbits.forEach((ring) => {
    ring.forEach((from, i) => {
      const to = ring[(i + 1) % ring.length];
      const [ax, ay, az] = nodes[from].position;
      const [bx, by, bz] = nodes[to].position;
      segments.push(ax, ay, az, bx, by, bz);
      edges.push({ from, to });
    });
  });

  // A few cross-orbit links carry collaboration: every third node on an orbit
  // joins the closest node on the orbit outside it. Keeping this sparse is what
  // stops 36 nodes from becoming a mesh.
  nodes.forEach((node, index) => {
    if (node.orbit >= ORBITS.length - 1) return;
    if (index % 3 !== 0) return;
    let best = null;
    let bestDistance = Infinity;
    nodes.forEach((candidate, candidateIndex) => {
      if (candidate.orbit !== node.orbit + 1) return;
      const [ax, ay, az] = node.position;
      const [bx, by, bz] = candidate.position;
      const distance = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidateIndex;
      }
    });
    if (best !== null) {
      segments.push(...node.position, ...nodes[best].position);
      edges.push({ from: index, to: best, cross: true });
    }
  });

  // Six spokes anchor the orbits to the care core without making it a starburst.
  orbits.forEach((ring) => {
    const step = Math.max(1, Math.round(ring.length / 2));
    for (let i = 0; i < ring.length; i += step) {
      const node = nodes[ring[i]];
      segments.push(...node.position, 0, 0, 0);
      edges.push({ from: ring[i], to: -1 }); // -1 is the care core at the origin
    }
  });

  return { nodes, segments, edges };
}

// A 20-facet icosahedron. Flat faces keep the "faceted care core" look the
// design system describes, and 60 triangles is all a 0.42-unit gem needs.
function icosahedron(radius) {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const positions = new Float32Array(faces.length * 9);
  const normals = new Float32Array(faces.length * 9);
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const c = [0, 0, 0];
  const ab = [0, 0, 0];
  const ac = [0, 0, 0];
  const normal = [0, 0, 0];
  faces.forEach((face, index) => {
    for (let k = 0; k < 3; k += 1) {
      const src = raw[face[k]];
      const length = Math.hypot(src[0], src[1], src[2]);
      const point = [src[0] / length, src[1] / length, src[2] / length];
      if (k === 0) a.splice(0, 3, ...point);
      if (k === 1) b.splice(0, 3, ...point);
      if (k === 2) c.splice(0, 3, ...point);
    }
    ab[0] = b[0] - a[0]; ab[1] = b[1] - a[1]; ab[2] = b[2] - a[2];
    ac[0] = c[0] - a[0]; ac[1] = c[1] - a[1]; ac[2] = c[2] - a[2];
    normal[0] = ab[1] * ac[2] - ab[2] * ac[1];
    normal[1] = ab[2] * ac[0] - ab[0] * ac[2];
    normal[2] = ab[0] * ac[1] - ab[1] * ac[0];
    const normalLength = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    normal[0] /= normalLength; normal[1] /= normalLength; normal[2] /= normalLength;
    [a, b, c].forEach((point, vertex) => {
      const offset = index * 9 + vertex * 3;
      positions[offset] = point[0] * radius;
      positions[offset + 1] = point[1] * radius;
      positions[offset + 2] = point[2] * radius;
      normals[offset] = normal[0];
      normals[offset + 1] = normal[1];
      normals[offset + 2] = normal[2];
    });
  });
  return { positions, normals };
}

const POINT_VERTEX = `
  attribute vec3 aPosition;
  attribute float aScale;
  uniform mat3 uRotation;
  uniform float uScale;
  uniform float uCameraZ;
  uniform vec2 uCameraOffset;
  uniform float uFocal;
  uniform float uAspect;
  uniform float uPixelScale;
  uniform float uPointSize;
  varying float vFade;
  void main() {
    vec3 p = uRotation * (aPosition * uScale);
    p.xy += uCameraOffset;
    float depth = max(0.6, uCameraZ - p.z);
    float inv = uFocal / depth;
    gl_Position = vec4((p.x * inv) / uAspect, p.y * inv, (depth - 4.0) / 10.0, 1.0);
    gl_PointSize = clamp(aScale * uPointSize * inv * uPixelScale, 1.0, 900.0);
    // Signals and nodes further away read fainter, which is the depth cue.
    vFade = clamp(1.25 - (depth - 4.0) * 0.12, 0.35, 1.0);
  }
`;

const POINT_FRAGMENT = `
  precision mediump float;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    vec2 offset = gl_PointCoord - vec2(0.5);
    float distance = length(offset);
    if (distance > 0.5) discard;
    float alpha = smoothstep(0.5, 0.12, distance) * uOpacity * vFade;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

const CORE_VERTEX = `
  attribute vec3 aPosition;
  attribute vec3 aNormal;
  uniform mat3 uRotation;
  uniform float uModelScale;
  uniform float uCameraZ;
  uniform vec2 uCameraOffset;
  uniform float uFocal;
  uniform float uAspect;
  varying vec3 vNormal;
  void main() {
    vec3 p = uRotation * (aPosition * uModelScale);
    p.xy += uCameraOffset;
    float depth = max(0.6, uCameraZ - p.z);
    float inv = uFocal / depth;
    gl_Position = vec4((p.x * inv) / uAspect, p.y * inv, (depth - 4.0) / 10.0, 1.0);
    vNormal = uRotation * aNormal;
  }
`;

const CORE_FRAGMENT = `
  precision mediump float;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vNormal;
  void main() {
    vec3 light = normalize(vec3(0.35, 0.75, 1.0));
    float lambert = clamp(dot(normalize(vNormal), light), 0.0, 1.0);
    vec3 shaded = uColor * (0.42 + 0.58 * lambert)
      + vec3(0.10, 0.05, 0.20) * pow(lambert, 3.0);
    gl_FragColor = vec4(shaded, uOpacity);
  }
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Scene shader failed to compile: ${message}`);
  }
  return shader;
}

function link(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Scene program failed to link: ${message}`);
  }
  return program;
}

// Column-major mat3 for Ry(angleY) * Rx(angleX), written into `out`.
function rotationMatrix(angleY, angleX, out) {
  const cy = Math.cos(angleY);
  const sy = Math.sin(angleY);
  const cx = Math.cos(angleX);
  const sx = Math.sin(angleX);
  // Ry * Rx
  out[0] = cy; out[1] = 0; out[2] = -sy;
  out[3] = sy * sx; out[4] = cx; out[5] = cy * sx;
  out[6] = sy * cx; out[7] = -sx; out[8] = cy * cx;
  return out;
}

export default function RecoveryNetwork({ quality, reducedMotion, frameloop }) {
  const hostRef = useRef(null);
  const apiRef = useRef(null);
  // The setup effect must not rebuild the GL scene when visibility changes, so
  // it reads the initial mode through a ref; the second effect keeps it current.
  const frameloopRef = useRef(frameloop);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.pointerEvents = 'none';
    const attributes = {
      alpha: true,
      antialias: quality.antialias,
      depth: true,
      powerPreference: 'low-power',
      premultipliedAlpha: false,
    };
    const gl =
      canvas.getContext('webgl2', attributes) ||
      canvas.getContext('webgl', attributes) ||
      canvas.getContext('experimental-webgl', attributes);
    if (!gl) {
      // The host already probes for WebGL; this is the belt-and-braces path.
      return undefined;
    }
    host.appendChild(canvas);

    let pointProgram;
    let coreProgram;
    try {
      pointProgram = link(gl, POINT_VERTEX, POINT_FRAGMENT);
      coreProgram = link(gl, CORE_VERTEX, CORE_FRAGMENT);
    } catch {
      // A decorative scene must never surface an error: drop the canvas and let
      // the host's gradient fallback show.
      canvas.remove();
      return undefined;
    }

    const uniform = (program, name) => gl.getUniformLocation(program, name);
    const pointUniforms = {
      rotation: uniform(pointProgram, 'uRotation'),
      scale: uniform(pointProgram, 'uScale'),
      cameraZ: uniform(pointProgram, 'uCameraZ'),
      cameraOffset: uniform(pointProgram, 'uCameraOffset'),
      focal: uniform(pointProgram, 'uFocal'),
      aspect: uniform(pointProgram, 'uAspect'),
      pixelScale: uniform(pointProgram, 'uPixelScale'),
      pointSize: uniform(pointProgram, 'uPointSize'),
      color: uniform(pointProgram, 'uColor'),
      opacity: uniform(pointProgram, 'uOpacity'),
    };
    const pointAttributes = {
      position: gl.getAttribLocation(pointProgram, 'aPosition'),
      scale: gl.getAttribLocation(pointProgram, 'aScale'),
    };
    const coreUniforms = {
      rotation: uniform(coreProgram, 'uRotation'),
      modelScale: uniform(coreProgram, 'uModelScale'),
      cameraZ: uniform(coreProgram, 'uCameraZ'),
      cameraOffset: uniform(coreProgram, 'uCameraOffset'),
      focal: uniform(coreProgram, 'uFocal'),
      aspect: uniform(coreProgram, 'uAspect'),
      color: uniform(coreProgram, 'uColor'),
      opacity: uniform(coreProgram, 'uOpacity'),
    };
    const coreAttributes = {
      position: gl.getAttribLocation(coreProgram, 'aPosition'),
      normal: gl.getAttribLocation(coreProgram, 'aNormal'),
    };

    const { nodes, segments, edges } = buildNetwork(quality.nodes);

    // Lines: one position buffer, two vertices per pathway.
    const lineBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segments), gl.STATIC_DRAW);

    // Nodes: static positions plus a scale per node. The hovered node's scale is
    // the only value ever rewritten, so a hover costs one bufferSubData.
    const nodePositions = new Float32Array(nodes.length * 3);
    const nodeScales = new Float32Array(nodes.length);
    nodes.forEach((node, index) => {
      nodePositions[index * 3] = node.position[0];
      nodePositions[index * 3 + 1] = node.position[1];
      nodePositions[index * 3 + 2] = node.position[2];
      nodeScales[index] = node.scale;
    });
    const nodePositionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nodePositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, nodePositions, gl.STATIC_DRAW);
    const nodeScaleBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nodeScaleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, nodeScales, gl.STATIC_DRAW);

    // Signals travel along real pathways, not from nowhere.
    const carriers = (() => {
      if (!edges.length) return [];
      const random = seeded(7);
      const count = Math.min(quality.pulses, edges.length);
      return Array.from({ length: count }, (_, i) => ({
        edge: edges[(i * 3 + Math.floor(random() * 4)) % edges.length],
        offset: random(),
        speed: 0.08 + random() * 0.1,
      }));
    })();
    const pulsePositions = new Float32Array(Math.max(1, carriers.length) * 3);
    const pulseBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pulseBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, pulsePositions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const core = icosahedron(0.42);
    const corePositionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corePositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, core.positions, gl.STATIC_DRAW);
    const coreNormalBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, coreNormalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, core.normals, gl.STATIC_DRAW);
    const coreVertexCount = core.positions.length / 3;

    // Glow and halo are large soft points behind the core; two of them recreate
    // the additive bloom without a second render pass or a texture.
    const glowBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glowBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0]), gl.STATIC_DRAW);
    const haloBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, haloBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);

    const state = {
      progress: reducedMotion ? 1 : 0,
      scale: reducedMotion ? 1 : 0.86,
      elapsed: 0,
      rotationY: 0,
      rotationX: 0,
      pointerX: 0,
      pointerY: 0,
      cameraX: 0,
      cameraY: 0,
      hoverIndex: -1,
      hoverScale: 1,
      breath: 1,
      glowScale: 1,
      aspect: 1,
      width: 0,
      height: 0,
      dpr: 1,
      raf: 0,
      last: 0,
      mode: 'always',
      disposed: false,
    };

    const rotation = new Float32Array(9);
    // One re-used slot for the hovered node's scale; no per-frame allocation.
    const scaleSlot = new Float32Array(1);
    const pointerTarget = { x: 0, y: 0 };

    function bindAttribute(buffer, location, size) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    }

    function setCommonLocals(uniforms) {
      gl.uniformMatrix3fv(uniforms.rotation, false, rotation);
      gl.uniform1f(uniforms.cameraZ, 7.1 - state.progress * 0.85);
      gl.uniform2f(uniforms.cameraOffset, state.cameraX, state.cameraY);
      gl.uniform1f(uniforms.focal, FOCAL);
      gl.uniform1f(uniforms.aspect, state.aspect);
    }

    function drawPoints(buffer, count, color, worldSize, opacity, useScales) {
      gl.useProgram(pointProgram);
      setCommonLocals(pointUniforms);
      gl.uniform1f(pointUniforms.scale, state.scale);
      gl.uniform1f(pointUniforms.pixelScale, state.height / 2);
      gl.uniform1f(pointUniforms.pointSize, worldSize);
      gl.uniform3fv(pointUniforms.color, color);
      gl.uniform1f(pointUniforms.opacity, opacity);
      bindAttribute(buffer, pointAttributes.position, 3);
      if (useScales) {
        bindAttribute(nodeScaleBuffer, pointAttributes.scale, 1);
      } else {
        gl.disableVertexAttribArray(pointAttributes.scale);
        gl.vertexAttrib1f(pointAttributes.scale, 1);
      }
      gl.drawArrays(gl.POINTS, 0, count);
    }

    function drawCore() {
      gl.useProgram(coreProgram);
      setCommonLocals(coreUniforms);
      gl.uniform3fv(coreUniforms.color, COLOR.core);
      gl.uniform1f(coreUniforms.opacity, state.progress);
      gl.uniform1f(coreUniforms.modelScale, state.breath);
      bindAttribute(corePositionBuffer, coreAttributes.position, 3);
      bindAttribute(coreNormalBuffer, coreAttributes.normal, 3);
      gl.drawArrays(gl.TRIANGLES, 0, coreVertexCount);
    }

    function draw() {
      if (state.disposed) return;
      gl.viewport(0, 0, state.width, state.height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      drawCore();
      // Additive bloom on top: no depth write, so the glow layers without
      // punching a hole in the lines behind it.
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      drawPoints(haloBuffer, 1, COLOR.coreGlow, 2.7 * state.glowScale, 0.18 * state.progress, false);
      drawPoints(glowBuffer, 1, COLOR.coreGlow, 1.95 * state.glowScale, 0.3 * state.progress, false);
      // A brighter inner bloom keeps the core reading as a light source rather
      // than a pale ball once the additive layers are composited.
      drawPoints(glowBuffer, 1, COLOR.core, 1.05 * state.glowScale, 0.5 * state.progress, false);

      gl.useProgram(pointProgram);
      setCommonLocals(pointUniforms);
      gl.uniform1f(pointUniforms.scale, state.scale);
      gl.uniform1f(pointUniforms.pixelScale, state.height / 2);
      gl.uniform3fv(pointUniforms.color, COLOR.link);
      gl.uniform1f(pointUniforms.opacity, 0.62 * state.progress);
      gl.uniform1f(pointUniforms.pointSize, 1);
      bindAttribute(lineBuffer, pointAttributes.position, 3);
      gl.disableVertexAttribArray(pointAttributes.scale);
      gl.vertexAttrib1f(pointAttributes.scale, 1);
      gl.drawArrays(gl.LINES, 0, segments.length / 3);

      drawPoints(nodePositionBuffer, nodes.length, COLOR.node, 0.155, 0.95 * state.progress, true);
      if (carriers.length) {
        gl.bindBuffer(gl.ARRAY_BUFFER, pulseBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, pulsePositions);
        drawPoints(pulseBuffer, carriers.length, COLOR.pulse, 0.09, state.progress, false);
      }
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
    }

    function update(delta) {
      const step = Math.min(delta, 0.05);
      state.elapsed += step;
      if (state.progress < 1) {
        state.progress = Math.min(1, state.progress + step / 1.2);
        const eased = 1 - (1 - state.progress) ** 3;
        state.scale = 0.86 + 0.14 * eased;
      }

      if (!reducedMotion) {
        state.rotationY += step * 0.045;
        state.rotationX = Math.sin(state.elapsed * 0.12) * 0.03;
        const ease = Math.min(1, step * 2.2);
        state.cameraX += (pointerTarget.x * 0.28 - state.cameraX) * ease;
        state.cameraY += (-pointerTarget.y * 0.16 - state.cameraY) * ease;
      }

      // Care core breathing: slow enough to read as calm, never as a heartbeat.
      state.breath = reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 0.85) * 0.035;
      state.glowScale = reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 0.85 + 0.6) * 0.06;

      rotationMatrix(state.rotationY, state.rotationX, rotation);
      const cameraZ = 7.1 - state.progress * 0.85;

      // Hover: the node nearest the cursor swells slightly. The canvas never
      // receives pointer events, so this reads the window position and cannot
      // interfere with a link or button.
      let nearest = -1;
      if (!reducedMotion && nodes.length) {
        let nearestDistance = 0.24;
        for (let i = 0; i < nodes.length; i += 1) {
          const [x, y, z] = nodes[i].position;
          // Same transform as the vertex shader, in JS.
          const rx = rotation[0] * x + rotation[3] * y + rotation[6] * z;
          const ry = rotation[1] * x + rotation[4] * y + rotation[7] * z;
          const rz = rotation[2] * x + rotation[5] * y + rotation[8] * z;
          const depth = Math.max(0.6, cameraZ - rz * state.scale);
          const ndcX = ((rx * state.scale + state.cameraX) * FOCAL) / depth / state.aspect;
          const ndcY = ((ry * state.scale + state.cameraY) * FOCAL) / depth;
          const distance = Math.hypot(ndcX - pointerTarget.x, ndcY + pointerTarget.y);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = i;
          }
        }
      }
      if (nearest !== state.hoverIndex) {
        if (state.hoverIndex >= 0) {
          state.hoverScale = 1;
          nodeScales[state.hoverIndex] = nodes[state.hoverIndex].scale;
          scaleSlot[0] = nodeScales[state.hoverIndex];
          gl.bindBuffer(gl.ARRAY_BUFFER, nodeScaleBuffer);
          gl.bufferSubData(gl.ARRAY_BUFFER, state.hoverIndex * 4, scaleSlot);
        }
        state.hoverIndex = nearest;
        state.hoverScale = 1;
      }
      const targetScale = nearest >= 0 ? 2.4 : 1;
      const nextScale = state.hoverScale + (targetScale - state.hoverScale) * Math.min(1, step * 6);
      if (nearest >= 0 && Math.abs(nextScale - state.hoverScale) > 0.002) {
        state.hoverScale = nextScale;
        nodeScales[nearest] = nodes[nearest].scale * nextScale;
        scaleSlot[0] = nodeScales[nearest];
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeScaleBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, nearest * 4, scaleSlot);
      }

      if (carriers.length) {
        carriers.forEach((carrier, index) => {
          const from = nodes[carrier.edge.from].position;
          const to = carrier.edge.to < 0 ? [0, 0, 0] : nodes[carrier.edge.to].position;
          const t = reducedMotion ? 0.5 : (carrier.offset + state.elapsed * carrier.speed) % 1;
          pulsePositions[index * 3] = from[0] + (to[0] - from[0]) * t;
          pulsePositions[index * 3 + 1] = from[1] + (to[1] - from[1]) * t;
          pulsePositions[index * 3 + 2] = from[2] + (to[2] - from[2]) * t;
        });
      }
    }

    function tick(now) {
      if (state.disposed || state.mode !== 'always') return;
      const delta = state.last ? (now - state.last) / 1000 : 1 / 60;
      state.last = now;
      update(delta);
      draw();
      state.raf = requestAnimationFrame(tick);
    }

    function start() {
      if (state.disposed || state.raf) return;
      state.last = 0;
      state.raf = requestAnimationFrame(tick);
    }

    function stop() {
      if (state.raf) cancelAnimationFrame(state.raf);
      state.raf = 0;
    }

    function renderOnce() {
      if (state.disposed) return;
      update(0);
      draw();
    }

    function setMode(mode) {
      state.mode = mode;
      if (mode === 'always') {
        start();
      } else {
        stop();
        if (mode === 'demand') {
          // Reduced motion: one static composition, no loop.
          state.progress = 1;
          state.scale = 1;
          renderOnce();
        }
      }
    }

    function resize() {
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, quality.dpr);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      state.dpr = dpr;
      state.width = width;
      state.height = height;
      state.aspect = rect.width / Math.max(1, rect.height);
      canvas.width = width;
      canvas.height = height;
      if (state.mode !== 'always') renderOnce();
    }

    function onPointerMove(event) {
      pointerTarget.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointerTarget.y = (event.clientY / window.innerHeight) * 2 - 1;
    }

    const onContextLost = (event) => {
      // Stop drawing; the host's capture listener swaps in the gradient.
      event.preventDefault();
      stop();
    };

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    if (observer) observer.observe(host);
    window.addEventListener('resize', resize);
    if (!reducedMotion && quality.parallax) {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
    }
    canvas.addEventListener('webglcontextlost', onContextLost, false);

    resize();
    // Paint once immediately so a hidden tab or a reduced-motion visitor still
    // sees the composition, then honour the requested frameloop.
    renderOnce();
    state.mode = frameloopRef.current;
    if (state.mode === 'always') start();

    apiRef.current = { setMode };

    return () => {
      state.disposed = true;
      stop();
      if (observer) observer.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      apiRef.current = null;
      gl.deleteBuffer(lineBuffer);
      gl.deleteBuffer(nodePositionBuffer);
      gl.deleteBuffer(nodeScaleBuffer);
      gl.deleteBuffer(pulseBuffer);
      gl.deleteBuffer(corePositionBuffer);
      gl.deleteBuffer(coreNormalBuffer);
      gl.deleteBuffer(glowBuffer);
      gl.deleteBuffer(haloBuffer);
      gl.deleteProgram(pointProgram);
      gl.deleteProgram(coreProgram);
      canvas.remove();
    };
  }, [quality, reducedMotion]);

  // The host switches the frameloop on visibility and intersection changes
  // without remounting the scene; this keeps the loop in step.
  useEffect(() => {
    frameloopRef.current = frameloop;
    if (apiRef.current) apiRef.current.setMode(frameloop);
  }, [frameloop]);

  return <div className="hero-visual__scene" ref={hostRef} />;
}
