/**
 * Smithsonian 3D Open Access (CC0) Integration Service
 * Handles random 10-model discovery, search, metadata enrichment via document.json,
 * and background downloading with real-time progress reporting.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { inspectGlb } = require("./glbInspector");

const SI_SEARCH_BASE = "https://3d-api.si.edu/api/v1.0/content/file/search";
const SI_DOC_BASE = "https://3d-api.si.edu/content/document";

/**
 * Maps Smithsonian unit codes and EDAN prefixes to human-readable museum names.
 */
const MUSEUM_UNIT_MAP = {
  nasm: "National Air and Space Museum",
  nmnh: "National Museum of Natural History",
  nmnhpaleo: "National Museum of Natural History (Paleobiology)",
  nmnhmammals: "National Museum of Natural History (Vertebrate Zoology)",
  nmnhvz: "National Museum of Natural History (Vertebrate Zoology)",
  nmnhherps: "National Museum of Natural History (Amphibians & Reptiles)",
  nmnhinv: "National Museum of Natural History (Invertebrate Zoology)",
  nmnhfishes: "National Museum of Natural History (Fishes)",
  nmnheducation: "National Museum of Natural History (Education)",
  nmnhanthro: "National Museum of Natural History (Anthropology)",
  nmnhbotany: "National Museum of Natural History (Botany)",
  nmnhmineral: "National Museum of Natural History (Mineral Sciences)",
  nmnhbirds: "National Museum of Natural History (Birds)",
  nmah: "National Museum of American History",
  chndm: "Cooper Hewitt, Smithsonian Design Museum",
  fsg: "National Museum of Asian Art (Freer | Sackler)",
  nmaahc: "National Museum of African American History and Culture",
  nmafa: "National Museum of African Art",
  npg: "National Portrait Gallery",
  saam: "Smithsonian American Art Museum",
  dpo: "Smithsonian Digitization Program Office",
  "ofeo-sg": "Smithsonian Gardens",
  sao: "Smithsonian Astrophysical Observatory",
  nzp: "Smithsonian's National Zoo & Conservation Biology Institute",
  acm: "Anacostia Community Museum",
  NMAI: "National Museum of the American Indian",
  nmai: "National Museum of the American Indian",
  npm: "National Postal Museum",
  hmsg: "Hirshhorn Museum and Sculpture Garden"
};

/**
 * Helper to perform an HTTPS/HTTP GET and return parsed JSON with timeout and redirect support.
 */
function fetchJson(url, timeoutMs = 8000, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          "User-Agent": "Cuenect-Hologram-Stage/2.1",
          Accept: "application/json"
        },
        timeout: timeoutMs
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          res.resume();
          const redirectUrl = new URL(res.headers.location, url).toString();
          fetchJson(redirectUrl, timeoutMs, maxRedirects - 1).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf-8");
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error(`Invalid JSON from ${url}: ${err.message}`));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
    });
    req.on("error", reject);
  });
}

/**
 * Streams a URL to a local file on disk with optional progress callback.
 */
function downloadFileWithProgress(url, destPath, expectedBytes = 0, onProgress = null, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          "User-Agent": "Cuenect-Hologram-Stage/2.1"
        },
        timeout: 30000
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          res.resume();
          const redirectUrl = new URL(res.headers.location, url).toString();
          downloadFileWithProgress(redirectUrl, destPath, expectedBytes, onProgress, maxRedirects - 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`Download failed with HTTP ${res.statusCode}`));
          return;
        }

        const contentLength = parseInt(res.headers["content-length"] || "0", 10);
        const totalBytes = contentLength > 0 ? contentLength : expectedBytes;
        let downloadedBytes = 0;

        const tmpPath = `${destPath}.part`;
        const fileStream = fs.createWriteStream(tmpPath);

        res.on("data", (chunk) => {
          downloadedBytes += chunk.length;
          if (onProgress) {
            onProgress(downloadedBytes, totalBytes);
          }
        });

        res.pipe(fileStream);

        fileStream.on("finish", () => {
          fileStream.close(() => {
            try {
              if (fs.existsSync(destPath)) {
                fs.unlinkSync(destPath);
              }
              fs.renameSync(tmpPath, destPath);
              resolve({ filePath: destPath, sizeBytes: downloadedBytes });
            } catch (err) {
              reject(err);
            }
          });
        });

        fileStream.on("error", (err) => {
          res.destroy();
          try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          } catch {}
          reject(err);
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Download connection timed out"));
    });
    req.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Generates a deterministic local AssetID for a Smithsonian 3d_package ID.
 */
function packageIdToAssetId(packageId) {
  const clean = String(packageId || "")
    .replace(/^3d_package:/i, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
  return `si_${clean.slice(0, 10)}`;
}

/**
 * Resolves museum name from EDAN record ID or unit code.
 */
function resolveMuseumFromCode(codeOrRecordId) {
  if (!codeOrRecordId) return "Smithsonian Institution";
  const cleaned = String(codeOrRecordId)
    .replace(/^edanmdm:/i, "")
    .split("_")[0]
    .toLowerCase();
  if (MUSEUM_UNIT_MAP[cleaned]) return MUSEUM_UNIT_MAP[cleaned];
  for (const [prefix, museum] of Object.entries(MUSEUM_UNIT_MAP)) {
    if (cleaned.startsWith(prefix)) return museum;
  }
  return "Smithsonian Institution";
}

/**
 * Extracts structured metadata, model derivative, and thumbnail from a Voyager document.json.
 */
function parseDocumentJson(packageId, fallbackTitle, doc) {
  if (!doc || !Array.isArray(doc.models) || doc.models.length === 0) {
    return null;
  }

  const modelNode = doc.models[0];
  const derivatives = Array.isArray(modelNode.derivatives) ? modelNode.derivatives : [];

  // 1. Choose best GLB model derivative: prefer Web3D Medium -> Web3D Low -> AR -> Web3D High
  const glbDerivatives = [];
  for (const d of derivatives) {
    if (!Array.isArray(d.assets)) continue;
    for (const a of d.assets) {
      if (a.uri && a.uri.toLowerCase().endsWith(".glb")) {
        glbDerivatives.push({
          usage: d.usage || "Web3D",
          quality: d.quality || "Medium",
          uri: a.uri,
          byteSize: Number(a.byteSize) || 0,
          numFaces: Number(a.numFaces) || 0,
          imageSize: Number(a.imageSize) || 0
        });
      }
    }
  }

  if (glbDerivatives.length === 0) return null;

  // Sort preference: Medium (<=25MB) -> Low -> AR -> High
  const qualityPriority = { Medium: 1, Low: 2, AR: 3, High: 4, Thumb: 5 };
  glbDerivatives.sort((a, b) => {
    const aUnderLimit = a.byteSize > 0 && a.byteSize <= 25 * 1024 * 1024 ? 0 : 10;
    const bUnderLimit = b.byteSize > 0 && b.byteSize <= 25 * 1024 * 1024 ? 0 : 10;
    const aScore = aUnderLimit + (qualityPriority[a.quality] || 6);
    const bScore = bUnderLimit + (qualityPriority[b.quality] || 6);
    return aScore - bScore;
  });

  const chosenModel = glbDerivatives[0];
  const modelUrl = chosenModel.uri.startsWith("http")
    ? chosenModel.uri
    : `${SI_DOC_BASE}/${packageId}/${chosenModel.uri}`;

  // 2. Choose best Thumbnail derivative: prefer Image2D Medium -> Low -> Thumb
  let thumbUri = null;
  const imagePriority = ["Medium", "Low", "Thumb", "High"];
  for (const q of imagePriority) {
    const found = derivatives.find(
      (d) =>
        d.usage === "Image2D" &&
        d.quality === q &&
        Array.isArray(d.assets) &&
        d.assets.length > 0 &&
        d.assets[0].uri
    );
    if (found) {
      thumbUri = found.assets[0].uri;
      break;
    }
  }

  // Fallback to metas[0].images if Image2D derivative was not listed
  if (!thumbUri && Array.isArray(doc.metas)) {
    for (const m of doc.metas) {
      if (Array.isArray(m.images) && m.images.length > 0) {
        const med = m.images.find((img) => img.quality === "Medium" || img.quality === "Low") || m.images[0];
        if (med && med.uri) {
          thumbUri = med.uri;
          break;
        }
      }
    }
  }

  const thumbnailUrl = thumbUri
    ? thumbUri.startsWith("http")
      ? thumbUri
      : `${SI_DOC_BASE}/${packageId}/${thumbUri}`
    : `${SI_DOC_BASE}/${packageId}/scene-image-medium.jpg`;

  // 3. Compute bounding box physical dimensions if available
  let computedDimensions = "";
  const units = modelNode.units || (Array.isArray(doc.scenes) && doc.scenes[0]?.units) || "cm";
  if (
    modelNode.boundingBox &&
    Array.isArray(modelNode.boundingBox.min) &&
    Array.isArray(modelNode.boundingBox.max)
  ) {
    const min = modelNode.boundingBox.min;
    const max = modelNode.boundingBox.max;
    const dx = Math.abs((max[0] || 0) - (min[0] || 0));
    const dy = Math.abs((max[1] || 0) - (min[1] || 0));
    const dz = Math.abs((max[2] || 0) - (min[2] || 0));
    if (dx > 0 || dy > 0 || dz > 0) {
      computedDimensions = `${dx.toFixed(1)} × ${dy.toFixed(1)} × ${dz.toFixed(1)} ${units}`;
    }
  }

  // 4. Parse EDAN metadata from metas
  let title = fallbackTitle || "Smithsonian 3D Artifact";
  let museum = "Smithsonian Institution";
  let creator = "";
  let date = "";
  let collection = "";
  let dimensions = computedDimensions;
  let description = "";
  let edanRecordId = "";

  if (Array.isArray(doc.metas)) {
    for (const meta of doc.metas) {
      if (meta.collection) {
        if (meta.collection.title && meta.collection.title.trim()) {
          title = meta.collection.title.trim();
        } else if (meta.collection.titles?.EN && meta.collection.titles.EN.trim()) {
          title = meta.collection.titles.EN.trim();
        }
        if (meta.collection.edanRecordId) {
          edanRecordId = meta.collection.edanRecordId;
          museum = resolveMuseumFromCode(edanRecordId);
        }
        if (meta.collection.edanEntry && typeof meta.collection.edanEntry === "string") {
          try {
            const edan = JSON.parse(meta.collection.edanEntry);
            if (edan.title && edan.title.trim()) title = edan.title.trim();
            if (edan.unitCode) {
              museum = resolveMuseumFromCode(edan.unitCode);
            }
            const descNR = edan.content?.descriptiveNonRepeating;
            if (descNR?.data_source) {
              museum = descNR.data_source;
            }
            if (descNR?.title?.content && descNR.title.content.trim()) {
              title = descNR.title.content.trim();
            }

            const freetext = edan.content?.freetext || {};
            const indexed = edan.content?.indexedStructured || {};

            // Creator / Maker / Collector / Taxon
            if (Array.isArray(freetext.name) && freetext.name.length > 0) {
              creator = freetext.name.map((n) => n.content).filter(Boolean).slice(0, 2).join(", ");
            } else if (Array.isArray(indexed.name) && indexed.name.length > 0) {
              creator = indexed.name.slice(0, 2).join(", ");
            }

            // Date
            if (Array.isArray(freetext.date) && freetext.date.length > 0) {
              date = freetext.date[0].content || "";
            } else if (Array.isArray(indexed.date) && indexed.date.length > 0) {
              date = indexed.date[0] || "";
            }

            // Collection / Object Type
            if (Array.isArray(freetext.objectType) && freetext.objectType.length > 0) {
              collection = freetext.objectType.map((o) => o.content).filter(Boolean).join(" · ");
            } else if (Array.isArray(freetext.setName) && freetext.setName.length > 0) {
              collection = freetext.setName[0].content || "";
            } else if (Array.isArray(indexed.object_type) && indexed.object_type.length > 0) {
              collection = indexed.object_type.slice(0, 2).join(" · ");
            } else if (Array.isArray(indexed.scientific_name) && indexed.scientific_name.length > 0) {
              collection = indexed.scientific_name[0] || "";
            }

            // Physical Dimensions
            if (Array.isArray(freetext.physicalDescription) && freetext.physicalDescription.length > 0) {
              const meas = freetext.physicalDescription.find((p) =>
                /measurement|dimension/i.test(p.label || "")
              );
              if (meas && meas.content) {
                dimensions = meas.content;
              }
            }

            // Description / Notes
            if (Array.isArray(freetext.notes) && freetext.notes.length > 0) {
              description = freetext.notes
                .map((n) => n.content)
                .filter(Boolean)
                .join(" ")
                .slice(0, 320);
            } else if (Array.isArray(freetext.physicalDescription) && freetext.physicalDescription.length > 0) {
              description = freetext.physicalDescription
                .map((p) => p.content)
                .filter(Boolean)
                .join(" · ")
                .slice(0, 280);
            }
          } catch {}
        }
      }
    }
  }

  if (!title || title === "Smithsonian 3D Model" || title === "Smithsonian 3D Artifact") {
    const rawFile = path.basename(chosenModel.uri, ".glb");
    const cleanedFile = rawFile
      .replace(/[-_]\d+k.*$/i, "")
      .replace(/[-_](low|medium|high|thumb|ar|draco|std).*$/i, "")
      .replace(/[-_]+/g, " ")
      .trim();
    if (cleanedFile && cleanedFile.length > 2) {
      title = cleanedFile.charAt(0).toUpperCase() + cleanedFile.slice(1);
    }
  }

  // Fallback synthesized description so the bottom-left plaque always has rich context
  if (!description) {
    const parts = [`3D digitized artifact from the ${museum}`];
    if (collection) parts.push(`(${collection})`);
    if (chosenModel.numFaces > 0) {
      parts.push(`— ${(chosenModel.numFaces / 1000).toFixed(0)}k triangles`);
    }
    if (computedDimensions) {
      parts.push(`· Scan dimensions: ${computedDimensions}`);
    }
    description = parts.join(" ") + ".";
  }

  const fileSizeBytes = chosenModel.byteSize || 2 * 1024 * 1024;
  const fileSizeMB = +(fileSizeBytes / (1024 * 1024)).toFixed(2);

  return {
    id: packageId,
    smithsonianId: packageId,
    packageUuid: String(packageId).replace(/^3d_package:/i, ""),
    assetId: packageIdToAssetId(packageId),
    title,
    thumbnailUrl,
    modelUrl,
    license: "CC0",
    fileSizeBytes,
    fileSizeMB,
    triangleCount: chosenModel.numFaces || 0,
    quality: chosenModel.quality || "Medium",
    dracoCompressed: true,
    metadata: {
      title,
      museum,
      creator: creator || museum,
      date: date || "Smithsonian Archive",
      collection: collection || "Open Access 3D Collection",
      dimensions: dimensions || computedDimensions || "",
      description,
      license: "CC0 1.0 Public Domain",
      sourceUrl: `https://3d.si.edu/object/3d/${packageId}`
    }
  };
}

/**
 * Fisher-Yates array shuffle in-place.
 */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

class SmithsonianExploreManager {
  constructor() {
    this.cachedTotalRows = 3200; // Refined dynamically on first search
    this.activeDownloads = new Map(); // packageId -> progress object
  }

  /**
   * Returns current active downloads as a plain object.
   */
  getActiveDownloadsSnapshot() {
    const out = {};
    for (const [k, v] of this.activeDownloads.entries()) {
      out[k] = { ...v };
    }
    return out;
  }

  /**
   * Queries Smithsonian 3D API, deduplicates by 3d_package, and returns 10 enriched CC0 models.
   */
  async fetchExploreModels({ query = "", count = 10, existingAssets = [] } = {}) {
    const cleanQuery = String(query || "").trim();
    const downloadedSet = new Set();
    const downloadedByAssetId = new Map();

    for (const a of existingAssets) {
      if (!a) continue;
      if (a.smithsonianId) {
        downloadedSet.add(a.smithsonianId);
        downloadedByAssetId.set(a.smithsonianId, a.AssetID);
      }
      if (a.AssetID) {
        downloadedSet.add(a.AssetID);
      }
    }

    let rawRows = [];

    if (cleanQuery) {
      const searchUrl = `${SI_SEARCH_BASE}?q=${encodeURIComponent(cleanQuery)}&file_type=glb&gltf_orientation_compliant=true&rows=120&start=0`;
      const res = await fetchJson(searchUrl, 8000);
      rawRows = Array.isArray(res?.rows) ? res.rows : [];
    } else {
      // Sample across diverse Smithsonian museum units + a random global offset so the 10 random models
      // showcase a rich variety (Air & Space, Paleobiology, American History, Art, Design, etc.)
      const featuredUnits = [
        "NASM",
        "NMAH",
        "NMNHPALEO",
        "CHNDM",
        "FSG",
        "SAAM",
        "NPG",
        "NMAAHC",
        "NMAfA",
        "DPO",
        "NMNHEDUCATION"
      ];
      const pickedUnits = shuffleArray([...featuredUnits]).slice(0, 3);
      const maxOffset = Math.max(0, this.cachedTotalRows - 80);
      const randomOffset = Math.floor(Math.random() * maxOffset);

      const urls = [
        `${SI_SEARCH_BASE}?file_type=glb&file_quality=Medium&gltf_orientation_compliant=true&rows=60&start=${randomOffset}`,
        ...pickedUnits.map(
          (unit) =>
            `${SI_SEARCH_BASE}?file_type=glb&file_quality=Medium&gltf_orientation_compliant=true&owning_unit=${unit}&rows=40&start=0`
        )
      ];

      const responses = await Promise.all(
        urls.map((u) => fetchJson(u, 8000).catch(() => ({ rows: [] })))
      );

      if (typeof responses[0]?.rowCount === "number" && responses[0].rowCount > 100) {
        this.cachedTotalRows = responses[0].rowCount;
      }

      // Balance across buckets: take up to 5 shuffled unique packages from each bucket
      // so high-volume skeletal collections don't drown out Air & Space, History, and Art.
      const bucketedPackages = new Map();
      for (const r of responses) {
        if (!Array.isArray(r?.rows)) continue;
        const localMap = new Map();
        for (const row of r.rows) {
          const pkgId = row?.content?.model_url || row?.url;
          if (!pkgId || typeof pkgId !== "string" || !pkgId.startsWith("3d_package:")) continue;
          if (!localMap.has(pkgId)) {
            localMap.set(pkgId, {
              packageId: pkgId,
              title: row.title || "Smithsonian 3D Model"
            });
          }
        }
        const pickedFromBucket = shuffleArray(Array.from(localMap.values())).slice(0, 5);
        for (const item of pickedFromBucket) {
          if (!bucketedPackages.has(item.packageId)) {
            bucketedPackages.set(item.packageId, item);
          }
        }
      }
      for (const item of bucketedPackages.values()) {
        rawRows.push({ url: item.packageId, title: item.title, content: { model_url: item.packageId } });
      }
    }

    // Group & deduplicate by 3d_package ID
    const uniquePackages = new Map();
    for (const row of rawRows) {
      const pkgId = row?.content?.model_url || row?.url;
      if (!pkgId || typeof pkgId !== "string" || !pkgId.startsWith("3d_package:")) continue;
      if (!uniquePackages.has(pkgId)) {
        uniquePackages.set(pkgId, {
          packageId: pkgId,
          title: row.title || "Smithsonian 3D Model"
        });
      }
    }

    const candidates = shuffleArray(Array.from(uniquePackages.values()));
    // Fetch slightly more than `count` in parallel in case any single document.json times out
    const batch = candidates.slice(0, Math.min(candidates.length, count + 5));

    const enrichedResults = await Promise.all(
      batch.map(async (item) => {
        try {
          const docUrl = `${SI_DOC_BASE}/${item.packageId}/document.json`;
          const doc = await fetchJson(docUrl, 6000);
          const parsed = parseDocumentJson(item.packageId, item.title, doc);
          if (!parsed) return null;

          const isDownloaded =
            downloadedSet.has(parsed.id) || downloadedSet.has(parsed.assetId);
          const resolvedLocalId = downloadedByAssetId.get(parsed.id) || parsed.assetId;
          parsed.isDownloaded = isDownloaded;
          parsed.localAssetId = resolvedLocalId;
          parsed.downloadedAssetId = isDownloaded ? resolvedLocalId : null;
          return parsed;
        } catch {
          return null;
        }
      })
    );

    const validModels = enrichedResults.filter(Boolean).slice(0, count);
    return {
      ok: true,
      offline: false,
      count: validModels.length,
      models: validModels,
      totalCatalogSize: this.cachedTotalRows,
      activeDownloads: this.getActiveDownloadsSnapshot()
    };
  }

  /**
   * Downloads a Smithsonian 3D model (.glb) and its thumbnail (.jpg) in the background,
   * emitting progress events and persisting to local disk.
   */
  async downloadModel({
    model,
    initiator = "web",
    targetDir,
    onProgress,
    onComplete,
    onError
  }) {
    const pkgId = model?.smithsonianId || model?.id;
    if (!model || !pkgId || !model.modelUrl) {
      throw new Error("Invalid model payload for download");
    }

    if (this.activeDownloads.has(pkgId)) {
      const existing = this.activeDownloads.get(pkgId);
      if (existing.status === "downloading") {
        return existing;
      }
    }

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const assetId = model.assetId || packageIdToAssetId(pkgId);
    const glbPath = path.join(targetDir, `${assetId}.glb`);
    const thumbPath = path.join(targetDir, `${assetId}.jpg`);

    const initialState = {
      id: pkgId,
      smithsonianId: pkgId,
      assetId,
      title: model.title || "Smithsonian 3D Model",
      status: "downloading",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: model.fileSizeBytes || 0,
      downloadedMB: 0,
      totalMB: model.fileSizeMB || 0,
      initiator,
      startedAt: Date.now()
    };

    this.activeDownloads.set(pkgId, initialState);
    if (onProgress) onProgress({ ...initialState });

    let lastEmitTime = 0;
    let lastEmitPct = -1;

    try {
      // Download thumbnail in parallel (non-fatal if thumbnail fails)
      const thumbPromise = model.thumbnailUrl
        ? downloadFileWithProgress(model.thumbnailUrl, thumbPath, 0, null).catch(() => null)
        : Promise.resolve(null);

      // Stream GLB with throttled progress updates
      const glbResult = await downloadFileWithProgress(
        model.modelUrl,
        glbPath,
        model.fileSizeBytes || 0,
        (downloadedBytes, totalBytes) => {
          const now = Date.now();
          const effectiveTotal = totalBytes > 0 ? totalBytes : model.fileSizeBytes || downloadedBytes;
          const pct =
            effectiveTotal > 0
              ? Math.min(99, Math.round((downloadedBytes / effectiveTotal) * 100))
              : 50;

          if (pct !== lastEmitPct && (now - lastEmitTime >= 120 || pct >= 99)) {
            lastEmitTime = now;
            lastEmitPct = pct;
            const state = {
              id: pkgId,
              smithsonianId: pkgId,
              assetId,
              title: model.title || "Smithsonian 3D Model",
              status: "downloading",
              progress: pct,
              downloadedBytes,
              totalBytes: effectiveTotal,
              downloadedMB: +(downloadedBytes / (1024 * 1024)).toFixed(2),
              totalMB: +(effectiveTotal / (1024 * 1024)).toFixed(2),
              initiator
            };
            this.activeDownloads.set(pkgId, state);
            if (onProgress) onProgress(state);
          }
        }
      );

      await thumbPromise;

      // Inspect downloaded GLB for polycount, dimensions, and web preview eligibility
      const glbInfo = inspectGlb(glbResult.filePath);
      const finalThumbPath = fs.existsSync(thumbPath) ? thumbPath : "#";

      const newAsset = {
        AssetID: assetId,
        AssetName: model.title || assetId,
        PlaylistName: "Smithsonian 3D",
        ThumbnailImagePath: finalThumbPath,
        ModelPath: glbResult.filePath,
        Category: 0,
        videoDuration: 20,
        isloaded: false,
        smithsonianId: pkgId,
        fileSizeBytes: glbInfo.fileSizeBytes || glbResult.sizeBytes,
        fileSizeMB: glbInfo.fileSizeMB || +(glbResult.sizeBytes / (1024 * 1024)).toFixed(2),
        triangleCount: glbInfo.triangleCount || model.triangleCount || 0,
        vertexCount: glbInfo.vertexCount || 0,
        meshCount: glbInfo.meshCount || 1,
        dimensions: glbInfo.dimensions || null,
        isWebPreviewable: glbInfo.isLoadable,
        isLoadable: glbInfo.isLoadable,
        rejectionReason: glbInfo.rejectionReason || null,
        metadata: model.metadata || {
          title: model.title || assetId,
          museum: "Smithsonian Institution",
          creator: "Smithsonian Institution",
          date: "",
          collection: "Open Access 3D",
          dimensions: "",
          description: "",
          license: "CC0 1.0 Public Domain",
          sourceUrl: `https://3d.si.edu/object/3d/${pkgId}`
        }
      };

      const doneState = {
        id: pkgId,
        smithsonianId: pkgId,
        assetId,
        title: newAsset.AssetName,
        status: "completed",
        progress: 100,
        downloadedBytes: newAsset.fileSizeBytes,
        totalBytes: newAsset.fileSizeBytes,
        downloadedMB: newAsset.fileSizeMB,
        totalMB: newAsset.fileSizeMB,
        initiator,
        asset: newAsset
      };

      this.activeDownloads.set(pkgId, doneState);
      if (onComplete) onComplete(doneState);

      // Clear from activeDownloads map after 30 seconds so memory stays clean
      setTimeout(() => {
        this.activeDownloads.delete(pkgId);
      }, 30000);

      return doneState;
    } catch (err) {
      const errState = {
        id: pkgId,
        smithsonianId: pkgId,
        assetId,
        title: model.title || "Smithsonian 3D Model",
        status: "error",
        progress: 0,
        error: err.message || "Download failed",
        initiator
      };
      this.activeDownloads.set(pkgId, errState);
      if (onError) onError(errState);
      setTimeout(() => {
        this.activeDownloads.delete(pkgId);
      }, 15000);
      throw err;
    }
  }
}

module.exports = {
  SmithsonianExploreManager,
  packageIdToAssetId
};
