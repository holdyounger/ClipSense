// pet-imgproc.cs - 桌宠精灵预处理（用完即删）
// 1) 从四角泛洪去除近白背景（容差内连通扩散 → alpha 0）
// 2) 裁切到不透明内容包围盒 + 4px 边距
// 用法: pet-imgproc.exe <in.png> <out.png>
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;

class PetImgProc {
  static void Main(string[] args) {
    string inPath = args[0], outPath = args[1];
    var src = new Bitmap(inPath);
    int w = src.Width, h = src.Height;
    var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) g.DrawImage(src, 0, 0, w, h);

    // LockBits 读全图像素
    var rect = new Rectangle(0, 0, w, h);
    var data = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    int stride = data.Stride;
    var bytes = new byte[stride * h];
    System.Runtime.InteropServices.Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);

    // 背景色 = 四角均值
    int[] corners = { 0, (w-1)*4, (h-1)*stride, (h-1)*stride + (w-1)*4 };
    long sr=0, sg=0, sb=0;
    foreach (var o in corners) { sr += bytes[o]; sg += bytes[o+1]; sb += bytes[o+2]; }
    int br=(int)(sr/4), bg=(int)(sg/4), bb=(int)(sb/4);

    // BFS 泛洪：色差 < 60 视为背景
    bool[] visited = new bool[w*h];
    var queue = new Queue<int>();
    for (int x=0; x<w; x++) { queue.Enqueue(x); queue.Enqueue((h-1)*w + x); }
    for (int y=0; y<h; y++) { queue.Enqueue(y*w); queue.Enqueue(y*w + w-1); }
    while (queue.Count > 0) {
      int idx = queue.Dequeue();
      if (visited[idx]) continue;
      visited[idx] = true;
      int o = idx*4;
      int dr = bytes[o]-br, dg = bytes[o+1]-bg, db = bytes[o+2]-bb;
      if (dr*dr + dg*dg + db*db > 3600) continue; // 60^2
      bytes[o+3] = 0; // 透明
      int x = idx % w, y = idx / w;
      if (x>0) queue.Enqueue(idx-1);
      if (x<w-1) queue.Enqueue(idx+1);
      if (y>0) queue.Enqueue(idx-w);
      if (y<h-1) queue.Enqueue(idx+w);
    }

    // 包围盒（alpha>0）
    int minX=w, minY=h, maxX=-1, maxY=-1;
    for (int y=0; y<h; y++) for (int x=0; x<w; x++) {
      if (bytes[y*stride + x*4 + 3] > 8) {
        if (x<minX) minX=x; if (x>maxX) maxX=x;
        if (y<minY) minY=y; if (y>maxY) maxY=y;
      }
    }
    System.Runtime.InteropServices.Marshal.Copy(bytes, 0, data.Scan0, bytes.Length);
    bmp.UnlockBits(data);

    int pad = 4;
    minX = Math.Max(0, minX-pad); minY = Math.Max(0, minY-pad);
    maxX = Math.Min(w-1, maxX+pad); maxY = Math.Min(h-1, maxY+pad);
    var outBmp = bmp.Clone(new Rectangle(minX, minY, maxX-minX+1, maxY-minY+1), PixelFormat.Format32bppArgb);
    outBmp.Save(outPath, ImageFormat.Png);
    Console.WriteLine("DONE " + outBmp.Width + "x" + outBmp.Height + " (src " + w + "x" + h + ")");
  }
}
