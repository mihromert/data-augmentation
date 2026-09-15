# Augment Lab

A local graphical application for augmenting YOLO object-detection datasets.
Images never leave your computer, and geometric augmentations update standard
YOLO bounding boxes or four-corner YOLO OBB annotations automatically.

## Supported dataset layout

```text
my-dataset/
├── images/
│   ├── train/
│   └── val/
├── labels/
│   ├── train/
│   └── val/
└── classes.txt
```

Images and labels may also sit directly inside `images/` and `labels/`.
Supported image formats are JPG, JPEG, PNG, WebP, and BMP.

## Start the GUI on Windows

Double-click **Start Augment Lab.cmd**. The app opens at
`http://localhost:3000` in your default browser.

If dependencies have not been installed yet, the launcher installs them once.
Keep the small minimized server window open while using the app; closing it
stops the local app.

## Workflow

1. Select **BB standard** (`class cx cy width height`) or **OBB corners**
   (`class x1 y1 x2 y2 x3 y3 x4 y4`) for the source labels.
2. Click **Choose dataset folder** and select the folder containing `images/`,
   `labels/`, and `classes.txt`.
3. Adjust copies, rotation, flips, brightness, contrast, saturation, hue,
   blur, noise, and minimum box visibility.
4. Inspect **Original** and **Augmented** previews.
5. Click **Choose output & generate**, then select a parent output folder.
6. Augment Lab creates a new timestamped YOLO dataset in the selected format.
   Originals are untouched.

Images without a matching label file are treated as valid background images.
Malformed YOLO label lines are skipped.

## Developer commands

```powershell
npm install
npm run dev
npm run build
```
