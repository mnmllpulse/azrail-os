import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const mount = document.querySelector("#scene");
if (!mount) throw new Error("Pulse globe mount is missing.");

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const mobile = matchMedia("(max-width: 640px)").matches;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05010a);
scene.fog = new THREE.FogExp2(0x05010a, .013);

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, .1, 1000);
camera.position.set(0, 4, mobile ? 31 : 27);

const renderer = new THREE.WebGLRenderer({ antialias: !mobile, alpha: false, powerPreference: "high-performance" });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.3 : 1.8));
renderer.outputColorSpace = THREE.SRGBColorSpace;
mount.append(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = .05;
controls.enablePan = false;
controls.minDistance = 15;
controls.maxDistance = 45;
controls.rotateSpeed = .38;

scene.add(new THREE.AmbientLight(0x8e7cac, 1.45));
const key = new THREE.DirectionalLight(0xf0eef5, 2.4);
key.position.set(35, 26, 40);
scene.add(key);
const rim = new THREE.DirectionalLight(0x7b4dff, 2.0);
rim.position.set(-34, -10, -28);
scene.add(rim);

const system = new THREE.Group();
scene.add(system);
const radius = 8;

system.add(new THREE.Mesh(
  new THREE.SphereGeometry(radius, mobile ? 64 : 96, mobile ? 48 : 72),
  new THREE.MeshStandardMaterial({
    color: 0x10091d,
    roughness: .83,
    metalness: .08,
    emissive: 0x130825,
    emissiveIntensity: .42,
  }),
));

system.add(new THREE.Mesh(
  new THREE.SphereGeometry(radius + .035, 48, 36),
  new THREE.MeshBasicMaterial({ color: 0x5c437f, wireframe: true, transparent: true, opacity: .075 }),
));

system.add(new THREE.Mesh(
  new THREE.SphereGeometry(radius + .45, 64, 48),
  new THREE.MeshBasicMaterial({
    color: 0x8a63ff,
    transparent: true,
    opacity: .055,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
));

for (const [r, x, y, z, opacity] of [
  [radius + 1.8, Math.PI / 2.34, .16, .05, .12],
  [radius + 3.1, Math.PI / 2.03, -.30, .44, .09],
  [radius + 4.5, Math.PI / 1.78, .32, -.38, .065],
]) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(r, .025, 8, mobile ? 120 : 192),
    new THREE.MeshBasicMaterial({
      color: 0xb497f4,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  ring.rotation.set(x, y, z);
  scene.add(ring);
}

const satellites = [];
for (let i = 0; i < (mobile ? 3 : 6); i++) {
  const orbit = new THREE.Group();
  orbit.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
  const r = radius + 2.1 + Math.random() * 4.2;
  const track = new THREE.Mesh(
    new THREE.TorusGeometry(r, .012, 6, 96),
    new THREE.MeshBasicMaterial({ color: 0x8d6ce0, transparent: true, opacity: .045 }),
  );
  track.rotation.x = Math.PI / 2;
  orbit.add(track);
  const sat = new THREE.Mesh(
    new THREE.SphereGeometry(.09, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xd8c7ff }),
  );
  orbit.add(sat);
  scene.add(orbit);
  satellites.push({ sat, r, a: Math.random() * Math.PI * 2, s: .08 + Math.random() * .18 });
}

if (!mobile) {
  const count = 800;
  const pts = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 80 + Math.random() * 180;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    pts[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pts[i * 3 + 1] = r * Math.cos(phi);
    pts[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pts, 3));
  scene.add(new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ color: 0x8b7da0, size: .16, transparent: true, opacity: .45, sizeAttenuation: true }),
  ));
}

const presence = new THREE.Group();
system.add(presence);
const markers = [];

function latLonToVec(lat, lon, r) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

function clearPresence() {
  for (const marker of markers) {
    presence.remove(marker.core, marker.halo);
    marker.core.geometry.dispose();
    marker.halo.geometry.dispose();
    marker.core.material.dispose();
    marker.halo.material.dispose();
  }
  markers.length = 0;
}

function syncPresence(sessions) {
  clearPresence();
  for (const session of sessions.slice(0, 100)) {
    if (typeof session.lat !== "number" || typeof session.lon !== "number") continue;
    const pos = latLonToVec(session.lat, session.lon, radius * 1.016);
    const self = !!session.isSelf;
    const base = self ? .15 : .105;

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(base, 12, 12),
      new THREE.MeshBasicMaterial({ color: self ? 0xffffff : 0xb497f4 }),
    );
    core.position.copy(pos);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(base * 2.7, 12, 12),
      new THREE.MeshBasicMaterial({
        color: 0xb497f4,
        transparent: true,
        opacity: self ? .17 : .10,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    halo.position.copy(pos);

    presence.add(core, halo);
    markers.push({ core, halo, phase: Math.random() * Math.PI * 2, base });
  }
}

addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.type !== "pulse:presence") return;
  syncPresence(Array.isArray(data.sessions) ? data.sessions : []);
});

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), .05);
  const now = performance.now() / 1000;
  if (!reduce) system.rotation.y += .00015 * 60 * dt;
  for (const s of satellites) {
    s.a += s.s * dt;
    s.sat.position.set(Math.cos(s.a) * s.r, 0, Math.sin(s.a) * s.r);
  }
  if (!reduce) {
    for (const marker of markers) {
      const pulse = .5 + .5 * Math.sin(now * 2.1 + marker.phase);
      marker.halo.scale.setScalar(.85 + pulse * .6);
      marker.halo.material.opacity = .14 * (1 - pulse * .55);
    }
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, matchMedia("(max-width: 640px)").matches ? 1.3 : 1.8));
});

window.parent?.postMessage({ type: "pulse:globe-ready" }, location.origin);
