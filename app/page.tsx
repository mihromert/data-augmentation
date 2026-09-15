"use client";

import { useCallback, useMemo, useRef, useState } from "react";

type AnnotationFormat = "bbox" | "obb";

type Point = [number, number];

type YoloAnnotation = {
  classId: number;
  points: Point[];
};

type DatasetImage = {
  path: string;
  labelPath: string;
  file: File;
  labelFile?: File;
};

type AugmentSettings = {
  copies: number;
  rotation: number;
  horizontalFlip: number;
  verticalFlip: number;
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  blur: number;
  noise: number;
};

type GeneratedTransform = {
  angle: number;
  flipX: boolean;
  flipY: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  blur: number;
  noise: number;
};

type DirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "bmp"]);
const BOX_COLORS = [
  "#9cf6d0",
  "#ffc978",
  "#91c9ff",
  "#f7a8d4",
  "#d4b5ff",
  "#ff9d8e",
  "#cde87d",
];

const defaultSettings: AugmentSettings = {
  copies: 3,
  rotation: 15,
  horizontalFlip: 50,
  verticalFlip: 0,
  brightness: 18,
  contrast: 15,
  saturation: 20,
  hue: 8,
  blur: 0.8,
  noise: 4,
};

function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function range(random: () => number, amount: number, center = 0) {
  return center + (random() * 2 - 1) * amount;
}

function makeTransform(settings: AugmentSettings, seed: number): GeneratedTransform {
  const random = seededRandom(seed);
  return {
    angle: range(random, settings.rotation),
    flipX: random() * 100 < settings.horizontalFlip,
    flipY: random() * 100 < settings.verticalFlip,
    brightness: range(random, settings.brightness, 100),
    contrast: range(random, settings.contrast, 100),
    saturation: range(random, settings.saturation, 100),
    hue: range(random, settings.hue),
    blur: random() * settings.blur,
    noise: random() * settings.noise,
  };
}

function boxPoints(x: number, y: number, width: number, height: number): Point[] {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return [
    [x - halfWidth, y - halfHeight],
    [x + halfWidth, y - halfHeight],
    [x + halfWidth, y + halfHeight],
    [x - halfWidth, y + halfHeight],
  ];
}

function annotationBounds(points: Point[]) {
  return {
    minX: Math.min(...points.map(([x]) => x)),
    maxX: Math.max(...points.map(([x]) => x)),
    minY: Math.min(...points.map(([, y]) => y)),
    maxY: Math.max(...points.map(([, y]) => y)),
  };
}

function parseYoloLabels(text: string, format: AnnotationFormat): YoloAnnotation[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const values = line.split(/\s+/).map(Number);
      const expectedValues = format === "obb" ? 9 : 5;
      if (values.length !== expectedValues || values.some((value) => !Number.isFinite(value))) {
        return [];
      }
      const classId = values[0];
      const points: Point[] = format === "obb"
        ? [
            [values[1], values[2]],
            [values[3], values[4]],
            [values[5], values[6]],
            [values[7], values[8]],
          ]
        : boxPoints(values[1], values[2], values[3], values[4]);
      const { minX, maxX, minY, maxY } = annotationBounds(points);
      if (maxX - minX <= 0 || maxY - minY <= 0) return [];
      return [{ classId, points }];
    });
}

function formatYoloLabels(annotations: YoloAnnotation[], format: AnnotationFormat) {
  return annotations.map((annotation) => {
    if (format === "obb") {
      const coordinates = annotation.points
        .flatMap(([x, y]) => [x, y])
        .map((value) => value.toFixed(6));
      return `${annotation.classId} ${coordinates.join(" ")}`;
    }
    const { minX, maxX, minY, maxY } = annotationBounds(annotation.points);
    return `${annotation.classId} ${((minX + maxX) / 2).toFixed(6)} ${((minY + maxY) / 2).toFixed(6)} ${(maxX - minX).toFixed(6)} ${(maxY - minY).toFixed(6)}`;
  }).join("\n");
}

function transformBoxes(
  annotations: YoloAnnotation[],
  transform: GeneratedTransform,
  imageWidth: number,
  imageHeight: number,
  format: AnnotationFormat,
): YoloAnnotation[] {
  const radians = (transform.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return annotations.flatMap((annotation) => {
    const transformedPoints: Point[] = annotation.points.map(([rawX, rawY]) => {
      // Canvas rotates in pixel space. Rotating normalized coordinates directly
      // only works for square images and distorts boxes on other aspect ratios.
      let centeredX = (rawX - 0.5) * imageWidth;
      let centeredY = (rawY - 0.5) * imageHeight;
      if (transform.flipX) centeredX = -centeredX;
      if (transform.flipY) centeredY = -centeredY;
      return [
        (centeredX * cos - centeredY * sin) / imageWidth + 0.5,
        (centeredX * sin + centeredY * cos) / imageHeight + 0.5,
      ] as Point;
    });

    const {
      minX: rawMinX,
      maxX: rawMaxX,
      minY: rawMinY,
      maxY: rawMaxY,
    } = annotationBounds(transformedPoints);
    const minX = Math.max(0, rawMinX);
    const maxX = Math.min(1, rawMaxX);
    const minY = Math.max(0, rawMinY);
    const maxY = Math.min(1, rawMaxY);
    const width = maxX - minX;
    const height = maxY - minY;
    if (width <= 0.001 || height <= 0.001) {
      return [];
    }

    const points = format === "obb"
      ? transformedPoints.map(([x, y]) => [
          Math.max(0, Math.min(1, x)),
          Math.max(0, Math.min(1, y)),
        ] as Point)
      : boxPoints((minX + maxX) / 2, (minY + maxY) / 2, width, height);
    return [{ classId: annotation.classId, points }];
  });
}

async function walkDirectory(
  directory: DirectoryHandle,
  prefix = "",
): Promise<Map<string, File>> {
  const files = new Map<string, File>();
  for await (const [name, handle] of directory.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "file") {
      files.set(path, await (handle as FileSystemFileHandle).getFile());
    } else {
      const nested = await walkDirectory(handle as DirectoryHandle, path);
      nested.forEach((file, nestedPath) => files.set(nestedPath, file));
    }
  }
  return files;
}

function extension(path: string) {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function withoutExtension(path: string) {
  return path.replace(/\.[^/.]+$/, "");
}

function fileName(path: string) {
  return path.split("/").pop() ?? path;
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`Could not decode ${file.name}`));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawBoxes(
  context: CanvasRenderingContext2D,
  annotations: YoloAnnotation[],
  classes: string[],
  width: number,
  height: number,
  format: AnnotationFormat,
) {
  const lineWidth = Math.max(2, Math.round(Math.min(width, height) / 260));
  context.font = `600 ${Math.max(12, Math.round(Math.min(width, height) / 35))}px ui-monospace, monospace`;
  context.textBaseline = "bottom";
  annotations.forEach((annotation) => {
    const color = BOX_COLORS[annotation.classId % BOX_COLORS.length];
    const { minX, minY } = annotationBounds(annotation.points);
    const left = minX * width;
    const top = minY * height;
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.beginPath();
    annotation.points.forEach(([x, y], index) => {
      const pixelX = x * width;
      const pixelY = y * height;
      if (index === 0) context.moveTo(pixelX, pixelY);
      else context.lineTo(pixelX, pixelY);
    });
    context.closePath();
    context.stroke();

    const label = classes[annotation.classId] ?? `class ${annotation.classId}`;
    const textWidth = context.measureText(label).width;
    const labelHeight = Math.max(18, Math.round(Math.min(width, height) / 25));
    const labelTop = Math.max(0, top - labelHeight);
    context.fillStyle = color;
    context.fillRect(left, labelTop, textWidth + 12, labelHeight);
    context.fillStyle = "#10201c";
    context.fillText(label, left + 6, labelTop + labelHeight - 3);

    if (format === "obb") {
      context.fillStyle = color;
      annotation.points.forEach(([x, y]) => {
        context.beginPath();
        context.arc(x * width, y * height, lineWidth * 1.35, 0, Math.PI * 2);
        context.fill();
      });
    }
  });
}

function applyNoise(context: CanvasRenderingContext2D, width: number, height: number, amount: number, seed: number) {
  if (amount <= 0) return;
  const imageData = context.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  const random = seededRandom(seed);
  const scale = amount * 2.55;
  for (let index = 0; index < pixels.length; index += 4) {
    const noise = (random() * 2 - 1) * scale;
    pixels[index] = Math.max(0, Math.min(255, pixels[index] + noise));
    pixels[index + 1] = Math.max(0, Math.min(255, pixels[index + 1] + noise));
    pixels[index + 2] = Math.max(0, Math.min(255, pixels[index + 2] + noise));
  }
  context.putImageData(imageData, 0, 0);
}

function renderAugmentation(
  image: HTMLImageElement,
  annotations: YoloAnnotation[],
  transform: GeneratedTransform,
  withOverlay: boolean,
  classes: string[],
  seed: number,
  format: AnnotationFormat,
) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: transform.noise > 0 });
  if (!context) throw new Error("Canvas rendering is not available.");

  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((transform.angle * Math.PI) / 180);
  context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
  context.filter = [
    `brightness(${transform.brightness}%)`,
    `contrast(${transform.contrast}%)`,
    `saturate(${transform.saturation}%)`,
    `hue-rotate(${transform.hue}deg)`,
    `blur(${transform.blur.toFixed(2)}px)`,
  ].join(" ");
  context.drawImage(image, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
  context.restore();
  context.filter = "none";
  applyNoise(context, canvas.width, canvas.height, transform.noise, seed);

  const transformedBoxes = transformBoxes(
    annotations,
    transform,
    canvas.width,
    canvas.height,
    format,
  );
  if (withOverlay) {
    drawBoxes(context, transformedBoxes, classes, canvas.width, canvas.height, format);
  }
  return { canvas, boxes: transformedBoxes };
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality = 0.92) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode augmented image."))),
      mimeType,
      quality,
    );
  });
}

async function writeFile(directory: DirectoryHandle, path: string, data: Blob | string) {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name) throw new Error("Invalid output filename.");
  let current = directory;
  for (const part of parts) {
    current = (await current.getDirectoryHandle(part, { create: true })) as DirectoryHandle;
  }
  const handle = await current.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  hint?: string;
}) {
  return (
    <label className="control">
      <span className="control-heading">
        <span>
          {label}
          {hint && <small>{hint}</small>}
        </span>
        <output>
          {value}
          {unit}
        </output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function browserSupportsFolders() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export default function Home() {
  const [sourceName, setSourceName] = useState("");
  const [sourceFiles, setSourceFiles] = useState<Map<string, File>>(new Map());
  const [images, setImages] = useState<DatasetImage[]>([]);
  const [classes, setClasses] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [annotationFormat, setAnnotationFormat] = useState<AnnotationFormat>("bbox");
  const [settings, setSettings] = useState(defaultSettings);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewMode, setPreviewMode] = useState<"original" | "augmented">("original");
  const [previewSeed, setPreviewSeed] = useState(8241);
  const [isScanning, setIsScanning] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Choose a YOLO dataset folder to begin.");
  const [error, setError] = useState("");
  const cancelRef = useRef(false);

  const selectedImage = images[selectedIndex];
  const totalOutput = images.length * settings.copies;

  const updateSetting = useCallback(
    (key: keyof AugmentSettings, value: number) => {
      setSettings((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const datasetSummary = useMemo(() => {
    if (!images.length) return null;
    const labeled = images.filter((image) => image.labelFile).length;
    return { labeled, missing: images.length - labeled };
  }, [images]);

  const renderPreview = useCallback(
    async (
      mode: "original" | "augmented",
      seed = previewSeed,
      imageIndex = selectedIndex,
      format = annotationFormat,
    ) => {
      const item = images[imageIndex];
      if (!item) return;
      try {
        const image = await loadImage(item.file);
        const boxes = item.labelFile ? parseYoloLabels(await item.labelFile.text(), format) : [];
        const transform =
          mode === "original"
            ? {
                angle: 0,
                flipX: false,
                flipY: false,
                brightness: 100,
                contrast: 100,
                saturation: 100,
                hue: 0,
                blur: 0,
                noise: 0,
              }
            : makeTransform(settings, seed);
        const { canvas } = renderAugmentation(
          image,
          boxes,
          transform,
          true,
          classes,
          seed,
          format,
        );
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
        const nextUrl = URL.createObjectURL(blob);
        setPreviewUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return nextUrl;
        });
        setPreviewMode(mode);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not render preview.");
      }
    },
    [annotationFormat, classes, images, previewSeed, selectedIndex, settings],
  );

  async function chooseDataset() {
    if (!browserSupportsFolders()) {
      setError("Folder access needs Chrome, Edge, or the Codex browser.");
      return;
    }
    setError("");
    setIsScanning(true);
    setStatus("Scanning images and labels…");
    try {
      const picker = window as typeof window & {
        showDirectoryPicker: (options?: { mode?: "read" | "readwrite" }) => Promise<DirectoryHandle>;
      };
      const handle = (await picker.showDirectoryPicker({ mode: "read" })) as DirectoryHandle;
      const files = await walkDirectory(handle);
      const classFile =
        files.get("classes.txt") ??
        files.get("classes.names") ??
        [...files.entries()].find(([path]) => /(^|\/)classes\.(txt|names)$/i.test(path))?.[1];
      const classNames = classFile
        ? (await classFile.text())
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean)
        : [];

      const discovered = [...files.entries()]
        .filter(([path]) => {
          const normalized = path.toLowerCase();
          return (
            IMAGE_EXTENSIONS.has(extension(normalized)) &&
            (normalized.startsWith("images/") || normalized.includes("/images/"))
          );
        })
        .map(([path, file]) => {
          const labelPath = withoutExtension(
            path.replace(/(^|\/)images\//i, "$1labels/"),
          ).concat(".txt");
          return { path, labelPath, file, labelFile: files.get(labelPath) };
        })
        .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

      if (!discovered.length) {
        throw new Error("No images were found. Expected a dataset folder containing images/.");
      }

      setSourceName(handle.name);
      setSourceFiles(files);
      setImages(discovered);
      setClasses(classNames);
      setSelectedIndex(0);
      setPreviewSeed(8241);
      setStatus(`Ready — ${discovered.length} images found.`);
      setTimeout(() => void renderInitial(discovered, classNames, annotationFormat), 0);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setStatus("Folder selection cancelled.");
      } else {
        setError(caught instanceof Error ? caught.message : "Could not read this dataset.");
        setStatus("Dataset not loaded.");
      }
    } finally {
      setIsScanning(false);
    }
  }

  async function renderInitial(
    discovered: DatasetImage[],
    classNames: string[],
    format: AnnotationFormat,
  ) {
    const item = discovered[0];
    const image = await loadImage(item.file);
    const boxes = item.labelFile ? parseYoloLabels(await item.labelFile.text(), format) : [];
    const identity: GeneratedTransform = {
      angle: 0,
      flipX: false,
      flipY: false,
      brightness: 100,
      contrast: 100,
      saturation: 100,
      hue: 0,
      blur: 0,
      noise: 0,
    };
    const { canvas } = renderAugmentation(image, boxes, identity, true, classNames, 1, format);
    const blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
    const url = URL.createObjectURL(blob);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return url;
    });
    setPreviewMode("original");
  }

  async function selectImage(index: number) {
    setSelectedIndex(index);
    await renderPreview(previewMode, previewSeed, index);
  }

  function changeAnnotationFormat(format: AnnotationFormat) {
    setAnnotationFormat(format);
    if (images.length) {
      void renderPreview(previewMode, previewSeed, selectedIndex, format);
    }
  }

  async function shufflePreview() {
    const nextSeed = Math.floor(Math.random() * 2_000_000_000);
    setPreviewSeed(nextSeed);
    await renderPreview("augmented", nextSeed);
  }

  async function startAugmentation() {
    if (!images.length || isRunning) return;
    if (!browserSupportsFolders()) {
      setError("Folder access needs Chrome, Edge, or the Codex browser.");
      return;
    }
    const picker = window as typeof window & {
      showDirectoryPicker: (options?: { mode?: "read" | "readwrite" }) => Promise<DirectoryHandle>;
    };

    setError("");
    try {
      const parent = (await picker.showDirectoryPicker({ mode: "readwrite" })) as DirectoryHandle;
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\..+/, "")
        .replace("T", "_");
      const outputName = `${sourceName || "yolo"}_augmented_${stamp}`;
      const output = (await parent.getDirectoryHandle(outputName, { create: true })) as DirectoryHandle;
      setIsRunning(true);
      cancelRef.current = false;
      setProgress(0);
      setStatus(`Creating ${totalOutput} augmented images…`);

      const classSource =
        sourceFiles.get("classes.txt") ??
        sourceFiles.get("classes.names") ??
        [...sourceFiles.entries()].find(([path]) => /(^|\/)classes\.(txt|names)$/i.test(path))?.[1];
      if (classSource) {
        await writeFile(output, "classes.txt", await classSource.text());
      } else if (classes.length) {
        await writeFile(output, "classes.txt", `${classes.join("\n")}\n`);
      }

      let completed = 0;
      for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
        if (cancelRef.current) break;
        const item = images[imageIndex];
        const decoded = await loadImage(item.file);
        const boxes = item.labelFile ? parseYoloLabels(await item.labelFile.text(), annotationFormat) : [];
        const relativeImagePath = item.path.replace(/^(?:.*\/)?images\//i, "");
        const relativeLabelPath = item.labelPath.replace(/^(?:.*\/)?labels\//i, "");
        const imageExt = extension(relativeImagePath);
        const mimeType = imageExt === "png" ? "image/png" : imageExt === "webp" ? "image/webp" : "image/jpeg";
        const baseImage = withoutExtension(relativeImagePath);
        const baseLabel = withoutExtension(relativeLabelPath);

        for (let copyIndex = 0; copyIndex < settings.copies; copyIndex += 1) {
          if (cancelRef.current) break;
          const seed = ((imageIndex + 1) * 1_000_003 + (copyIndex + 1) * 97_003) >>> 0;
          const transform = makeTransform(settings, seed);
          const { canvas, boxes: transformedBoxes } = renderAugmentation(
            decoded,
            boxes,
            transform,
            false,
            classes,
            seed,
            annotationFormat,
          );
          const suffix = `_aug_${String(copyIndex + 1).padStart(2, "0")}`;
          const imageBlob = await canvasToBlob(canvas, mimeType, 0.92);
          await writeFile(output, `images/${baseImage}${suffix}.${imageExt}`, imageBlob);
          await writeFile(
            output,
            `labels/${baseLabel}${suffix}.txt`,
            transformedBoxes.length ? `${formatYoloLabels(transformedBoxes, annotationFormat)}\n` : "",
          );
          completed += 1;
          setProgress(Math.round((completed / totalOutput) * 100));
          setStatus(`Augmenting ${fileName(item.path)} · ${completed} of ${totalOutput}`);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      if (cancelRef.current) {
        setStatus(`Stopped — ${completed} files were saved in ${outputName}.`);
      } else {
        setProgress(100);
        setStatus(`Complete — ${completed} images saved in ${outputName}.`);
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setStatus("Output folder selection cancelled.");
      } else {
        setError(caught instanceof Error ? caught.message : "Augmentation failed.");
        setStatus("The run stopped before completion.");
      }
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#" aria-label="Augment Lab home">
          <span className="brand-mark" aria-hidden="true">
            A+
          </span>
          <span>
            <strong>Augment Lab</strong>
            <small>YOLO dataset studio</small>
          </span>
        </a>
        <span className="privacy-badge">
          <span className="status-dot" />
          Local processing only
        </span>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">ANNOTATION-AWARE AUGMENTATION</p>
          <h1>More training data.<br />Boxes still where they belong.</h1>
          <p className="hero-copy">
            Create varied YOLO images without uploading a single file. Every rotation and flip
            updates its bounding boxes automatically.
          </p>
        </div>
        <div className="hero-action">
          <button className="button primary large" onClick={chooseDataset} disabled={isScanning || isRunning}>
            <span aria-hidden="true">＋</span>
            {isScanning ? "Scanning…" : images.length ? "Change dataset" : "Choose dataset folder"}
          </button>
          <p>Expected: images/ · labels/ · classes.txt</p>
        </div>
      </section>

      {error && (
        <div className="notice error" role="alert">
          <span>!</span>
          <p>{error}</p>
          <button onClick={() => setError("")} aria-label="Dismiss error">×</button>
        </div>
      )}

      <section className="workspace">
        <aside className="panel settings-panel">
          <div className="panel-title">
            <div>
              <p className="section-number">01</p>
              <h2>Recipe</h2>
            </div>
            <button className="text-button" onClick={() => setSettings(defaultSettings)}>
              Reset
            </button>
          </div>

          <div className="control-group">
            <p className="group-label">OUTPUT</p>
            <div className="format-control">
              <span>Input &amp; output annotations</span>
              <div className="segmented format-options" aria-label="Annotation format">
                <button
                  className={annotationFormat === "bbox" ? "active" : ""}
                  onClick={() => changeAnnotationFormat("bbox")}
                  disabled={isRunning}
                  type="button"
                >
                  BB standard
                </button>
                <button
                  className={annotationFormat === "obb" ? "active" : ""}
                  onClick={() => changeAnnotationFormat("obb")}
                  disabled={isRunning}
                  type="button"
                >
                  OBB corners
                </button>
              </div>
              <small>
                {annotationFormat === "bbox"
                  ? "class · center x/y · width · height"
                  : "class · four normalized corner points"}
              </small>
            </div>
            <Slider
              label="Copies per image"
              value={settings.copies}
              min={1}
              max={10}
              onChange={(value) => updateSetting("copies", value)}
            />
          </div>

          <div className="control-group">
            <p className="group-label">GEOMETRY</p>
            <Slider
              label="Rotation"
              hint="random ± angle"
              value={settings.rotation}
              min={0}
              max={45}
              unit="°"
              onChange={(value) => updateSetting("rotation", value)}
            />
            <Slider
              label="Horizontal flip"
              value={settings.horizontalFlip}
              min={0}
              max={100}
              unit="%"
              onChange={(value) => updateSetting("horizontalFlip", value)}
            />
            <Slider
              label="Vertical flip"
              value={settings.verticalFlip}
              min={0}
              max={100}
              unit="%"
              onChange={(value) => updateSetting("verticalFlip", value)}
            />
          </div>

          <div className="control-group">
            <p className="group-label">COLOR & TEXTURE</p>
            <Slider
              label="Brightness"
              value={settings.brightness}
              min={0}
              max={50}
              unit="%"
              onChange={(value) => updateSetting("brightness", value)}
            />
            <Slider
              label="Contrast"
              value={settings.contrast}
              min={0}
              max={50}
              unit="%"
              onChange={(value) => updateSetting("contrast", value)}
            />
            <Slider
              label="Saturation"
              value={settings.saturation}
              min={0}
              max={60}
              unit="%"
              onChange={(value) => updateSetting("saturation", value)}
            />
            <Slider
              label="Hue shift"
              value={settings.hue}
              min={0}
              max={45}
              unit="°"
              onChange={(value) => updateSetting("hue", value)}
            />
            <Slider
              label="Blur"
              value={settings.blur}
              min={0}
              max={4}
              step={0.2}
              unit="px"
              onChange={(value) => updateSetting("blur", value)}
            />
            <Slider
              label="Sensor noise"
              value={settings.noise}
              min={0}
              max={15}
              unit="%"
              onChange={(value) => updateSetting("noise", value)}
            />
          </div>
        </aside>

        <section className="panel preview-panel">
          <div className="panel-title preview-heading">
            <div>
              <p className="section-number">02</p>
              <h2>Preview</h2>
            </div>
            {images.length > 0 && (
              <div className="segmented" aria-label="Preview mode">
                <button
                  className={previewMode === "original" ? "active" : ""}
                  onClick={() => void renderPreview("original")}
                >
                  Original
                </button>
                <button
                  className={previewMode === "augmented" ? "active" : ""}
                  onClick={() => void renderPreview("augmented")}
                >
                  Augmented
                </button>
              </div>
            )}
          </div>

          <div className={`preview-stage ${previewUrl ? "has-image" : ""}`}>
            {previewUrl ? (
              <img src={previewUrl} alt={`Bounding box preview of ${selectedImage?.file.name ?? "dataset image"}`} />
            ) : (
              <div className="empty-state">
                <span className="empty-icon" aria-hidden="true">▧</span>
                <h3>Your preview will appear here</h3>
                <p>Choose a dataset folder to inspect images and bounding boxes.</p>
              </div>
            )}
            {previewUrl && (
              <div className="preview-overlay">
                <span>{selectedIndex + 1} / {images.length}</span>
                <span>{previewMode}</span>
              </div>
            )}
          </div>

          {images.length > 0 && (
            <div className="preview-footer">
              <div className="image-nav">
                <button
                  aria-label="Previous image"
                  onClick={() => void selectImage((selectedIndex - 1 + images.length) % images.length)}
                >
                  ←
                </button>
                <div>
                  <strong>{fileName(selectedImage.path)}</strong>
                  <small>{selectedImage.labelFile ? "Label matched" : "No label file"}</small>
                </div>
                <button
                  aria-label="Next image"
                  onClick={() => void selectImage((selectedIndex + 1) % images.length)}
                >
                  →
                </button>
              </div>
              <button className="button secondary" onClick={() => void shufflePreview()}>
                <span aria-hidden="true">↻</span>
                New variation
              </button>
            </div>
          )}
        </section>

        <aside className="panel run-panel">
          <div className="panel-title">
            <div>
              <p className="section-number">03</p>
              <h2>Generate</h2>
            </div>
          </div>

          {datasetSummary ? (
            <div className="dataset-card">
              <div className="dataset-icon">YOLO</div>
              <div>
                <strong>{sourceName}</strong>
                <small>{images.length} source images</small>
              </div>
            </div>
          ) : (
            <div className="dataset-card muted">
              <div className="dataset-icon">—</div>
              <div>
                <strong>No dataset selected</strong>
                <small>Choose a folder above</small>
              </div>
            </div>
          )}

          <dl className="summary-list">
            <div>
              <dt>Matched labels</dt>
              <dd>{datasetSummary?.labeled ?? "—"}</dd>
            </div>
            <div>
              <dt>Classes</dt>
              <dd>{classes.length || "—"}</dd>
            </div>
            <div>
              <dt>Annotation format</dt>
              <dd>{annotationFormat === "bbox" ? "BB" : "OBB"}</dd>
            </div>
            <div>
              <dt>New images</dt>
              <dd>{images.length ? totalOutput : "—"}</dd>
            </div>
            <div className="total-row">
              <dt>Final dataset size</dt>
              <dd>{images.length ? images.length + totalOutput : "—"}</dd>
            </div>
          </dl>

          {datasetSummary && datasetSummary.missing > 0 && (
            <p className="warning">
              {datasetSummary.missing} image{datasetSummary.missing === 1 ? "" : "s"} without labels will be
              treated as background images.
            </p>
          )}

          <div className="run-status" aria-live="polite">
            <div className="status-line">
              <span>{status}</span>
              {isRunning && <strong>{progress}%</strong>}
            </div>
            {(isRunning || progress === 100) && (
              <div className="progress-track">
                <span style={{ width: `${progress}%` }} />
              </div>
            )}
          </div>

          {isRunning ? (
            <button
              className="button danger full"
              onClick={() => {
                cancelRef.current = true;
                setStatus("Stopping after the current file…");
              }}
            >
              Stop safely
            </button>
          ) : (
            <button
              className="button primary full"
              disabled={!images.length}
              onClick={() => void startAugmentation()}
            >
              Choose output & generate
              <span aria-hidden="true">→</span>
            </button>
          )}
          <p className="output-note">
            A new timestamped folder is created. Your original dataset is never changed.
          </p>
        </aside>
      </section>

      <footer>
        <p>Built for YOLO BB & OBB datasets · JPG, PNG, WebP & BMP</p>
        <p>Runs entirely on this device</p>
      </footer>
    </main>
  );
}
