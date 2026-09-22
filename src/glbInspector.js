/**
 * GLB Inspector & Validator
 * Reads GLB binary headers and Chunk 0 (JSON) to extract model metadata (file size,
 * triangle count, vertex count, dimensions) in < 2ms without decompressing vertex buffers.
 */

const fs = require("fs");
const path = require("path");

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_TRIANGLE_COUNT = 250000; // 250k triangles

// Known fallback directories where models might live
const CANDIDATE_DIRS = [
  path.join(process.env.USERPROFILE || process.env.HOME || "", "Documents", "Cuenect"),
  path.join(process.env.USERPROFILE || process.env.HOME || "", "Documents", "Cuenect", "models"),
  "C:\\Unity\\Kayunet\\Assets\\StreamingAssets",
  path.join(__dirname, "..", "models"),
  path.join(__dirname, "..", "public", "models"),
  process.cwd()
];

/**
 * Resolves a model path to an absolute existing file on disk.
 * Supports full Windows paths, relative paths, and bare filenames.
 *
 * @param {string} rawPath
 * @returns {string|null} Resolved absolute path or null if not found
 */
function resolveModelFilePath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;

  const cleanPath = rawPath.trim().replace(/^["']|["']$/g, "");
  if (!cleanPath || cleanPath === "#") return null;

  // 1. Direct path check
  if (fs.existsSync(cleanPath)) {
    try {
      if (fs.statSync(cleanPath).isFile()) return path.resolve(cleanPath);
    } catch {}
  }

  // With .glb appended if missing
  if (!cleanPath.toLowerCase().endsWith(".glb") && fs.existsSync(cleanPath + ".glb")) {
    try {
      if (fs.statSync(cleanPath + ".glb").isFile()) return path.resolve(cleanPath + ".glb");
    } catch {}
  }

  // 2. Bare filename check across candidate directories
  const baseName = path.basename(cleanPath);
  const candidates = [baseName];
  if (!baseName.toLowerCase().endsWith(".glb")) {
    candidates.push(baseName + ".glb");
  }

  for (const dir of CANDIDATE_DIRS) {
    for (const fileCandidate of candidates) {
      const fullCandidate = path.join(dir, fileCandidate);
      if (fs.existsSync(fullCandidate)) {
        try {
          if (fs.statSync(fullCandidate).isFile()) return path.resolve(fullCandidate);
        } catch {}
      }
    }
  }

  return null;
}

/**
 * Inspects a GLB file and extracts metadata.
 *
 * @param {string} filePath Absolute or resolvable path to .glb file
 * @returns {{
 *   resolvedPath: string|null,
 *   exists: boolean,
 *   fileSizeBytes: number,
 *   fileSizeMB: number,
 *   triangleCount: number,
 *   vertexCount: number,
 *   meshCount: number,
 *   dimensions: { x: number, y: number, z: number } | null,
 *   isLoadable: boolean,
 *   rejectionReason: string | null
 * }}
 */
function inspectGlb(filePath) {
  const resolved = resolveModelFilePath(filePath);
  if (!resolved || !fs.existsSync(resolved)) {
    return {
      resolvedPath: null,
      exists: false,
      fileSizeBytes: 0,
      fileSizeMB: 0,
      triangleCount: 0,
      vertexCount: 0,
      meshCount: 0,
      dimensions: null,
      isLoadable: false,
      rejectionReason: "File not found on server disk"
    };
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    return {
      resolvedPath: resolved,
      exists: false,
      fileSizeBytes: 0,
      fileSizeMB: 0,
      triangleCount: 0,
      vertexCount: 0,
      meshCount: 0,
      dimensions: null,
      isLoadable: false,
      rejectionReason: `Could not stat file: ${err.message}`
    };
  }

  const fileSizeBytes = stat.size;
  const fileSizeMB = +(fileSizeBytes / (1024 * 1024)).toFixed(2);

  // Fast check on file size threshold before reading any bytes
  if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
    return {
      resolvedPath: resolved,
      exists: true,
      fileSizeBytes,
      fileSizeMB,
      triangleCount: -1,
      vertexCount: -1,
      meshCount: -1,
      dimensions: null,
      isLoadable: false,
      rejectionReason: `File size (${fileSizeMB} MB) exceeds maximum limit of 25 MB`
    };
  }

  // Read the 12-byte header + Chunk 0 length & type (20 bytes total)
  let fd;
  try {
    fd = fs.openSync(resolved, "r");
    const headerBuf = Buffer.alloc(20);
    const bytesRead = fs.readSync(fd, headerBuf, 0, 20, 0);
    if (bytesRead < 20) {
      fs.closeSync(fd);
      return {
        resolvedPath: resolved,
        exists: true,
        fileSizeBytes,
        fileSizeMB,
        triangleCount: 0,
        vertexCount: 0,
        meshCount: 0,
        dimensions: null,
        isLoadable: false,
        rejectionReason: "Corrupt or truncated GLB header (<20 bytes)"
      };
    }

    const magic = headerBuf.readUInt32LE(0); // 0x46546C67 ("glTF")
    const version = headerBuf.readUInt32LE(4);
    const totalLength = headerBuf.readUInt32LE(8);
    const chunkLength = headerBuf.readUInt32LE(12);
    const chunkType = headerBuf.readUInt32LE(16); // 0x4E4F534A ("JSON")

    if (magic !== 0x46546c67 || chunkType !== 0x4e4f534a) {
      fs.closeSync(fd);
      return {
        resolvedPath: resolved,
        exists: true,
        fileSizeBytes,
        fileSizeMB,
        triangleCount: 0,
        vertexCount: 0,
        meshCount: 0,
        dimensions: null,
        isLoadable: false,
        rejectionReason: "Invalid GLB container (magic or chunk header mismatch)"
      };
    }

    // Read Chunk 0 JSON content
    const jsonBuf = Buffer.alloc(chunkLength);
    fs.readSync(fd, jsonBuf, 0, chunkLength, 20);
    fs.closeSync(fd);

    const gltf = JSON.parse(jsonBuf.toString("utf8"));
    const accessors = Array.isArray(gltf.accessors) ? gltf.accessors : [];
    const meshes = Array.isArray(gltf.meshes) ? gltf.meshes : [];
    const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];

    // Calculate triangle and vertex counts per mesh
    let totalTriangles = 0;
    let totalVertices = 0;

    // Track mesh usage by nodes for instanced geometry
    const meshInstanceCount = new Map();
    for (const node of nodes) {
      if (typeof node.mesh === "number") {
        meshInstanceCount.set(node.mesh, (meshInstanceCount.get(node.mesh) || 0) + 1);
      }
    }

    let minBound = [Infinity, Infinity, Infinity];
    let maxBound = [-Infinity, -Infinity, -Infinity];

    for (let mIdx = 0; mIdx < meshes.length; mIdx++) {
      const mesh = meshes[mIdx];
      if (!mesh || !Array.isArray(mesh.primitives)) continue;

      const instances = meshInstanceCount.get(mIdx) || 1;
      let meshTriangles = 0;
      let meshVertices = 0;

      for (const prim of mesh.primitives) {
        const mode = typeof prim.mode === "number" ? prim.mode : 4; // 4 = TRIANGLES

        // Indices calculation
        if (typeof prim.indices === "number" && accessors[prim.indices]) {
          const acc = accessors[prim.indices];
          const count = acc.count || 0;
          if (mode === 4) {
            meshTriangles += Math.floor(count / 3);
          } else if (mode === 5 || mode === 6) {
            meshTriangles += Math.max(0, count - 2);
          }
        }

        // Vertex positions & bounds
        if (prim.attributes && typeof prim.attributes.POSITION === "number") {
          const posAcc = accessors[prim.attributes.POSITION];
          if (posAcc) {
            meshVertices += posAcc.count || 0;

            // If primitive is not indexed, triangles are derived from vertex count
            if (prim.indices === undefined) {
              if (mode === 4) {
                meshTriangles += Math.floor((posAcc.count || 0) / 3);
              } else if (mode === 5 || mode === 6) {
                meshTriangles += Math.max(0, (posAcc.count || 0) - 2);
              }
            }

            // Bounding box extraction
            if (Array.isArray(posAcc.min) && Array.isArray(posAcc.max)) {
              for (let i = 0; i < 3; i++) {
                if (posAcc.min[i] < minBound[i]) minBound[i] = posAcc.min[i];
                if (posAcc.max[i] > maxBound[i]) maxBound[i] = posAcc.max[i];
              }
            }
          }
        }
      }

      totalTriangles += meshTriangles * instances;
      totalVertices += meshVertices * instances;
    }

    const hasValidBounds = isFinite(minBound[0]) && isFinite(maxBound[0]);
    const dimensions = hasValidBounds
      ? {
          x: +(maxBound[0] - minBound[0]).toFixed(3),
          y: +(maxBound[1] - minBound[1]).toFixed(3),
          z: +(maxBound[2] - minBound[2]).toFixed(3)
        }
      : null;

    const isPolyOk = totalTriangles <= MAX_TRIANGLE_COUNT;
    const isLoadable = isPolyOk;
    let rejectionReason = null;
    if (!isPolyOk) {
      rejectionReason = `Polygon count (${totalTriangles.toLocaleString()} triangles) exceeds limit of ${MAX_TRIANGLE_COUNT.toLocaleString()}`;
    }

    return {
      resolvedPath: resolved,
      exists: true,
      fileSizeBytes,
      fileSizeMB,
      triangleCount: totalTriangles,
      vertexCount: totalVertices,
      meshCount: meshes.length,
      dimensions,
      isLoadable,
      rejectionReason
    };
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    return {
      resolvedPath: resolved,
      exists: true,
      fileSizeBytes,
      fileSizeMB,
      triangleCount: 0,
      vertexCount: 0,
      meshCount: 0,
      dimensions: null,
      isLoadable: false,
      rejectionReason: `Error parsing GLB metadata: ${err.message}`
    };
  }
}

module.exports = {
  MAX_FILE_SIZE_BYTES,
  MAX_TRIANGLE_COUNT,
  resolveModelFilePath,
  inspectGlb
};
