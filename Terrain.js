import * as THREE from 'three';
import { generateSoilDetailTexture } from './GrassUtils.js';

export function getTerrainHeight(x, z) {
  return Math.sin(x * 0.05) * Math.cos(z * 0.05) * 3 +
         Math.sin(x * 0.1) * Math.cos(z * 0.1) * 1.5 +
         Math.sin(x * 0.2) * Math.cos(z * 0.2) * 0.5;
}

export function createTerrain(scene) {
  // Increased vertex resolution for smoother "lift" deformation and lighting
  const terrainGeo = new THREE.PlaneGeometry(200, 200, 256, 256);
  const vertices = terrainGeo.attributes.position.array;
  
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i];
    const y = vertices[i + 1];
    vertices[i + 2] = getTerrainHeight(x, y);
  }
  terrainGeo.computeVertexNormals();

  // Generate HD Soil Texture
  const soilMap = generateSoilDetailTexture();
  // Repeat heavily for detail
  soilMap.repeat.set(16, 16); 

  const terrainMat = new THREE.MeshStandardMaterial({
    color: 0x5a4d3d, // Base earth color
    map: soilMap,
    roughness: 0.9,
    metalness: 0.0,
  });

  // Inject Custom Logic for LOD and Wind Lift
  terrainMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uPlayerPos = { value: new THREE.Vector3() };
    shader.uniforms.uWindStrength = { value: 0 };
    
    // Pass reference to allow external updates
    terrainMat.userData.shader = shader;

    shader.vertexShader = `
      uniform float uTime;
      uniform vec3 uPlayerPos;
      uniform float uWindStrength;
      varying float vDistToPlayer;
      varying vec2 vWorldUV;
      
      // Simplex noise function
      vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
      float snoise(vec2 v) {
        const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
        vec2 i  = floor(v + dot(v, C.yy) );
        vec2 x0 = v - i + dot(i, C.xx);
        vec2 i1;
        i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
        vec4 x12 = x0.xyxy + C.xxzz;
        x12.xy -= i1;
        i = mod289(i);
        vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 )) + i.x + vec3(0.0, i1.x, 1.0 ));
        vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
        m = m*m ;
        return 105.0 * dot( m*m, vec3( dot(p.x,x0), dot(p.y,x12.xy), dot(p.z,x12.zw) ) );
      }

      ${shader.vertexShader}
    `;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      #include <begin_vertex>
      
      vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
      vDistToPlayer = distance(worldPos.xz, uPlayerPos.xz);
      vWorldUV = worldPos.xz;

      // LOD mask for "Loose Soil Lift"
      // Only lift soil close to player (within 64m) to save visual noise elsewhere
      float lodMask = 1.0 - smoothstep(40.0, 64.0, vDistToPlayer);
      
      // "Loose" map based on noise
      float looseFactor = snoise(worldPos.xz * 0.1);
      looseFactor = smoothstep(0.2, 0.8, looseFactor); 
      
      if (lodMask > 0.01 && uWindStrength > 0.1) {
         // Animate lift
         float windEffect = sin(uTime * 2.0 + worldPos.x * 0.5 + worldPos.z * 0.5);
         
         // Only lift up (positive Y), jittery/dusty movement
         float lift = smoothstep(0.0, 1.0, windEffect) * looseFactor * uWindStrength * 0.15;
         
         // Add some high frequency flutter
         lift += sin(uTime * 10.0 + worldPos.x * 5.0) * 0.02 * looseFactor;
         
         transformed.y += lift * lodMask;
         
         // Perturb Normal slightly to catch light on the lifted soil
         // (Approximation for performance)
         objectNormal = normalize(objectNormal + vec3(
            sin(uTime * 5.0) * 0.1 * lift, 
            0.0, 
            cos(uTime * 5.0) * 0.1 * lift
         ));
      }
      `
    );
    
    shader.fragmentShader = `
      varying float vDistToPlayer;
      varying vec2 vWorldUV;
      ${shader.fragmentShader}
    `;
    
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `
      // Base color from texture
      vec4 texColor = texture2D(map, vMapUv);
      diffuseColor *= texColor;
      
      // HD Detail Pass (LOD)
      // Only blend in high frequency noise/grit near player
      float detailLOD = 1.0 - smoothstep(20.0, 64.0, vDistToPlayer);
      
      if (detailLOD > 0.01) {
         // Sample map again at much higher frequency
         vec4 detailTex = texture2D(map, vWorldUV * 2.0); // 20x scale relative to world
         
         // Blend overlay
         vec3 detailed = mix(diffuseColor.rgb, diffuseColor.rgb * detailTex.rgb * 1.2, 0.5);
         diffuseColor.rgb = mix(diffuseColor.rgb, detailed, detailLOD);
      }
      `
    );
  };

  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.rotation.x = -Math.PI / 2;
  terrain.receiveShadow = true;
  scene.add(terrain);
  
  return terrain;
}

