import * as THREE from 'three';
import { GRASS_VERTEX_LOGIC } from './GrassShader.js';
import { createGrassGeometry } from './GrassGeometry.js';
import { noise, generateWindNoiseTexture } from './GrassUtils.js';

// removed function noise(x, z) {}
// removed const GRASS_VERTEX_LOGIC = `...`;

export class GrassSystem {
  constructor(scene, getTerrainHeight, renderer) {
    // Generate Wind Noise Texture
    const windTex = generateWindNoiseTexture();

    this.uniforms = { 
      uTime: { value: 0 }, 
      uPlayerPos: { value: new THREE.Vector3(0, -100, 0) },
      uPlayerVel: { value: new THREE.Vector3(0, 0, 0) },
      uTrailMap: { value: null }, 
      uTerrainSize: { value: 200.0 },
      uWindNoise: { value: windTex },
      uWindTime: { value: 0 },      // Accumulated time based on wind speed
      uWindStrength: { value: 1.0 } // Current global wind multiplier
    };
    
    this.windTime = 0;
    this.currentWindStrength = 1.0;

    this.renderer = renderer;
    this.scene = scene;
    this.getTerrainHeight = getTerrainHeight;
    this.lastPlayerPos = new THREE.Vector3(0, -100, 0);
    
    this.group = new THREE.Group();
    scene.add(this.group);

    // Initialize the trail persistence system (FBO)
    this.initTrailSystem();
    
    // Initialize Geometry and Material reused by all chunks
    this.baseGeometry = createGrassGeometry();
    this.initMaterials();

    // Create Grass Chunks
    this.chunks = [];
    this.initChunks();
  }

  // removed generateWindNoiseTexture() {}

  initTrailSystem() {
    // 1. Render Target for storing trails
    const res = 1024; // Higher resolution for cleaner trails
    this.trailTarget = new THREE.WebGLRenderTarget(res, res, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RedFormat,
      type: THREE.HalfFloatType,
    });
    
    this.uniforms.uTrailMap.value = this.trailTarget.texture;

    // 2. Scene for the trail rendering
    this.trailScene = new THREE.Scene();
    
    // 3. Camera covering the terrain
    // Terrain is 200x200, centered at 0,0
    const halfSize = 100;
    this.trailCamera = new THREE.OrthographicCamera(-halfSize, halfSize, halfSize, -halfSize, 0.1, 100);
    this.trailCamera.position.set(0, 50, 0);
    this.trailCamera.lookAt(0, 0, 0);
    // Orient camera so Top of texture maps to -Z (Standard UV mapping alignment)
    this.trailCamera.up.set(0, 0, -1);

    // 4. "Brush" - The player's footprint influence
    // Smaller brush for accurate feet position
    const brushGeo = new THREE.PlaneGeometry(0.8, 0.8); 
    const brushMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });
    
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255, 255, 255, 1.0)'); 
    grd.addColorStop(0.4, 'rgba(255, 255, 255, 0.8)');
    grd.addColorStop(1, 'rgba(0, 0, 0, 0)'); 
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 64, 64);
    
    const brushTex = new THREE.CanvasTexture(canvas);
    brushMat.map = brushTex;
    brushMat.alphaMap = brushTex;
    
    this.brush = new THREE.Mesh(brushGeo, brushMat);
    this.brush.rotation.x = -Math.PI / 2;
    this.trailScene.add(this.brush);
    
    // 5. "Fade" Quad
    const fadeGeo = new THREE.PlaneGeometry(200, 200);
    const fadeMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.005, // Very slow fade to allow wind recovery mechanic to shine
      side: THREE.DoubleSide
    });
    this.fadeQuad = new THREE.Mesh(fadeGeo, fadeMat);
    this.fadeQuad.rotation.x = -Math.PI / 2;
    this.fadeQuad.position.y = -0.1;
    this.trailScene.add(this.fadeQuad);
  }

  // removed createGeometry() {}

  initMaterials() {
    const patchShader = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      
      shader.vertexShader = `
        uniform float uTime;
        uniform vec3 uPlayerPos;
        uniform vec3 uPlayerVel;
        uniform sampler2D uTrailMap;
        uniform float uTerrainSize;
        uniform sampler2D uWindNoise;
        uniform float uWindTime;
        uniform float uWindStrength;
        varying float vHeight;
        varying vec3 vWorldPosition;
        ${shader.vertexShader}
      `;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        GRASS_VERTEX_LOGIC
      );
    };

    // 1. Visible Material
    this.baseMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, 
      roughness: 1.0, 
      metalness: 0.0,
      side: THREE.DoubleSide,
      flatShading: false,
      onBeforeCompile: (shader) => {
        patchShader(shader);
        
        shader.fragmentShader = `
          varying float vHeight;
          varying vec3 vInstanceColor;
        ` + shader.fragmentShader;
        
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `
          // Hyper-realistic gradients
          vec3 bottomColor = vec3(0.02, 0.05, 0.01); // Dark root
          vec3 topColor = vec3(0.25, 0.6, 0.1);      // Vibrant tip
          
          vec3 col = mix(bottomColor, topColor, pow(vHeight, 0.8));
          
          // Apply instance variation
          col *= vInstanceColor * 1.5; // Boost saturation from instance color
          
          // Micro-detail: Slight noise along height
          float microNoise = fract(sin(dot(vWorldPosition.xy, vec2(12.9, 78.2))) * 43758.5);
          col += (microNoise - 0.5) * 0.05 * vHeight; // Dusty tips

          // Root Ambient Occlusion
          float ao = smoothstep(-0.05, 0.3, vHeight);
          col *= ao;
          
          diffuseColor.rgb = col;
          `
        );
        
        // Inject vInstanceColor support in vertex for main material
        shader.vertexShader = shader.vertexShader.replace(
           'varying vec3 vWorldPosition;',
           'varying vec3 vWorldPosition; varying vec3 vInstanceColor;'
        );
        shader.vertexShader = shader.vertexShader.replace(
           'vHeight = uv.y;',
           'vHeight = uv.y; vInstanceColor = instanceColor;'
        );
      }
    });

    // 2. Depth Material (For Shadows)
    this.baseDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      onBeforeCompile: (shader) => {
        patchShader(shader);
      }
    });
  }

  initChunks() {
    const terrainSize = 200;
    const chunkSize = 25; // Break into 8x8 grid (64 chunks)
    const density = 250; // High density (approx 2x previous)
    
    // Pre-allocate temporary objects
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    
    // Create chunks
    for (let x = -terrainSize/2; x < terrainSize/2; x += chunkSize) {
      for (let z = -terrainSize/2; z < terrainSize/2; z += chunkSize) {
        this.createChunk(x, z, chunkSize, density, dummy, color);
      }
    }
  }

  createChunk(startX, startZ, size, density, dummy, color) {
    const area = size * size;
    const totalInstances = Math.floor(area * density);
    
    // Split into Low LOD (base) and High LOD (detail)
    // Low LOD: 20% of grass, always visible in medium range
    // High LOD: 80% of grass, only visible in close range
    const baseCount = Math.floor(totalInstances * 0.2);
    const detailCount = totalInstances - baseCount;

    const meshBase = new THREE.InstancedMesh(this.baseGeometry, this.baseMaterial, baseCount);
    const meshDetail = new THREE.InstancedMesh(this.baseGeometry, this.baseMaterial, detailCount);
    
    // Enable shadows
    meshBase.castShadow = true;
    meshBase.receiveShadow = true;
    meshDetail.castShadow = true; // Warning: Expensive
    meshDetail.receiveShadow = true;
    
    // Assign custom depth material for correct shadow deformation
    meshBase.customDepthMaterial = this.baseDepthMaterial;
    meshDetail.customDepthMaterial = this.baseDepthMaterial;

    this.fillMesh(meshBase, 0, baseCount, startX, startZ, size, dummy, color);
    this.fillMesh(meshDetail, 0, detailCount, startX, startZ, size, dummy, color);

    this.group.add(meshBase);
    this.group.add(meshDetail);
    
    // Store chunk info for LOD updates
    this.chunks.push({
      center: new THREE.Vector3(startX + size/2, 0, startZ + size/2),
      meshBase: meshBase,
      meshDetail: meshDetail,
      size: size
    });
  }

  fillMesh(mesh, offset, count, startX, startZ, size, dummy, color) {
    let idx = 0;
    while(idx < count) {
      const x = startX + Math.random() * size;
      const z = startZ + Math.random() * size;
      
      const y = this.getTerrainHeight(x, z);
      dummy.position.set(x, y, z);
      
      dummy.rotation.y = Math.random() * Math.PI * 2;
      dummy.rotation.x = (Math.random() - 0.5) * 0.2; 
      dummy.rotation.z = (Math.random() - 0.5) * 0.2;

      // Region based height
      const region = noise(x * 0.015, z * 0.015); 
      const tallFactor = THREE.MathUtils.smoothstep(region, 0.0, 0.8);
      
      // Height variation
      const hScale = 0.4 + Math.random() * 0.4 + (tallFactor * 0.8);
      
      // Thinner stands
      const wScale = 0.5 + Math.random() * 0.5;
      
      dummy.scale.set(wScale, hScale, wScale);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
      
      // --- Hyper-Realistic Color Variation ---
      // Use noise for patch variation + random per-blade jitter
      const patchNoise = noise(x * 0.02, z * 0.02); // Broad patches
      
      // Base Palettes (H, S, L)
      // 1. Lush Green (Healthy)
      // 2. Dry/Yellow (Dead/Dying)
      // 3. Deep Green (Shadowy/Rich)
      
      const hueJitter = (Math.random() - 0.5) * 0.05;
      const satJitter = (Math.random() - 0.5) * 0.1;
      const lightJitter = (Math.random() - 0.5) * 0.15;

      if (patchNoise > 0.6) {
         // Dry patch
         color.setHSL(0.15 + hueJitter, 0.6 + satJitter, 0.4 + lightJitter); 
      } else if (patchNoise < -0.3) {
         // Deep rich patch
         color.setHSL(0.25 + hueJitter, 0.7 + satJitter, 0.2 + lightJitter);
      } else {
         // Standard mix
         color.setHSL(0.22 + hueJitter, 0.5 + satJitter, 0.35 + lightJitter);
      }
      
      // Random very dead blade
      if (Math.random() < 0.02) {
          color.setHSL(0.12, 0.4, 0.4); // Brown-ish
      }

      mesh.setColorAt(idx, color);
      
      idx++;
    }
  }

  update(time, dt, playerPosition, camera, sunDirection, lodHigh = 128, lodLow = 256) {
    this.uniforms.uTime.value = time;
    
    // --- Wind Dynamics ---
    // Calculate global wind variance (Gusts and Lulls)
    // Combine two sine waves for irregular "breathing" of the wind
    const cycle1 = Math.sin(time * 0.1);         // Slow 60s cycle
    const cycle2 = Math.sin(time * 0.4 + 2.0);   // Faster 15s cycle
    
    // Combined normalized -1 to 1
    const rawWind = (cycle1 + cycle2 * 0.5) / 1.5; 
    
    // Map to strength multiplier:
    // Calm (0.2) to Stormy (1.6)
    // Use smoothstep to make the 'states' linger slightly
    const normWind = THREE.MathUtils.smoothstep(rawWind, -0.8, 0.8);
    const targetStrength = THREE.MathUtils.lerp(0.1, 1.8, normWind);
    
    // Smoothly transition current strength (inertia)
    this.currentWindStrength += (targetStrength - this.currentWindStrength) * dt * 0.2;
    
    // Accumulate wind time based on current speed
    // This makes the waves move faster when wind is stronger
    this.windTime += dt * this.currentWindStrength;

    this.uniforms.uWindTime.value = this.windTime;
    this.uniforms.uWindStrength.value = this.currentWindStrength;

    if (playerPosition) {
      this.brush.position.set(playerPosition.x, 0, playerPosition.z);

      if (this.renderer && this.trailTarget) {
        const currentRenderTarget = this.renderer.getRenderTarget();
        const currentAutoClear = this.renderer.autoClear;
        
        this.renderer.setRenderTarget(this.trailTarget);
        this.renderer.autoClear = false; 
        
        this.renderer.render(this.trailScene, this.trailCamera);
        
        this.renderer.setRenderTarget(currentRenderTarget);
        this.renderer.autoClear = currentAutoClear;
      }
      
      this.uniforms.uPlayerPos.value.copy(playerPosition);
      
      if (dt > 0.0001) {
        const vel = new THREE.Vector3()
          .subVectors(playerPosition, this.lastPlayerPos)
          .divideScalar(dt);
        this.uniforms.uPlayerVel.value.copy(vel);
      }
      this.lastPlayerPos.copy(playerPosition);
    }

    if (playerPosition && camera) {
      this.updateLOD(playerPosition, camera, lodHigh, lodLow);
    }
  }

  updateLOD(playerPosition, camera, distHigh, distLow) {
    const px = playerPosition.x;
    const pz = playerPosition.z;

    // Get camera forward direction projected on XZ
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    fwd.y = 0;
    fwd.normalize();
    const fx = fwd.x;
    const fz = fwd.z;

    // Calculate LOD Oval Centers
    // We shift the center of the LOD area forward so the "edge" is just behind the camera
    // and the majority of the detail is projected in front.
    
    // High Detail: Shift significantly forward
    const shiftHigh = distHigh * 0.75; 
    const chx = px + fx * shiftHigh;
    const chz = pz + fz * shiftHigh;

    // Low Detail: Shift moderately
    const shiftLow = distLow * 0.4;
    const clx = px + fx * shiftLow;
    const clz = pz + fz * shiftLow;

    // Aspect ratio > 1.0 compresses the width, making the field an oval
    const aspect = 1.4; 

    for (let chunk of this.chunks) {
      const cx = chunk.center.x;
      const cz = chunk.center.z;

      // --- High LOD Check ---
      const dxH = cx - chx;
      const dzH = cz - chz;
      
      // Project vector onto forward axis
      const fDistH = dxH * fx + dzH * fz;
      
      // Project vector onto right axis (rejection)
      const sxH = dxH - fx * fDistH;
      const szH = dzH - fz * fDistH;
      
      // Elliptical distance: (forward)^2 + (side * aspect)^2
      const dSqH = fDistH*fDistH + (sxH*sxH + szH*szH) * aspect * aspect;
      
      const isHigh = dSqH < (distHigh * distHigh);

      if (isHigh) {
        chunk.meshBase.visible = true;
        chunk.meshDetail.visible = true;
        continue;
      }

      // --- Low LOD Check ---
      const dxL = cx - clx;
      const dzL = cz - clz;
      
      const fDistL = dxL * fx + dzL * fz;
      const sxL = dxL - fx * fDistL;
      const szL = dzL - fz * fDistL;
      
      // Slightly wider oval for low LOD background
      const aspectLow = aspect * 0.8;
      const dSqL = fDistL*fDistL + (sxL*sxL + szL*szL) * aspectLow * aspectLow;
      
      const isLow = dSqL < (distLow * distLow);

      chunk.meshBase.visible = isLow;
      chunk.meshDetail.visible = false;
    }
  }
}

