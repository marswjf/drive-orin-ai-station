set -u
LLM=/var/lib/llm
BIND=$LLM/llama/bin-cuda
M=/opt/m/llm/Qwen3.6-35B-A3B-UD-IQ4_XS.gguf

echo "════ 1. 解压 CUDA 版（与 CPU 版并存，可回退）════"
systemctl stop llm-server 2>/dev/null || true
rm -rf $BIND /var/tmp/cuda
mkdir -p $BIND
tar -xzf /var/tmp/llama-cuda.tar.gz -C /var/tmp
cp -a /var/tmp/cuda/* $BIND/
chmod +x $BIND/llama-* $BIND/ggml-* 2>/dev/null || true
rm -rf /var/tmp/cuda /var/tmp/llama-cuda.tar.gz
echo "文件数: $(ls $BIND | wc -l)   体积: $(du -sh $BIND | cut -f1)"
echo "-- 自带的 CUDA 运行时（板上只有 11.4，必须用这些 12.x）--"
ls -la $BIND/libcud* $BIND/libcubla* 2>/dev/null | awk '{printf "  %-34s %s\n", $9, $5}'

echo
echo "════ 2. 依赖自检 ════"
cd $BIND
export LD_LIBRARY_PATH=$BIND:/usr/lib
echo "-- ldd llama-bench 里未解析的项（应为空）--"
ldd ./llama-bench 2>&1 | grep -i 'not found' || echo "  （全部解析成功）"
echo "-- 是否链到板上的驱动 libcuda.so.1 --"
ldd ./libggml-cuda.so 2>&1 | grep -iE 'libcuda|libcudart|libcublas'

echo
echo "════ 3. GPU 是否被识别 ════"
./llama-bench --list-devices 2>&1 | head -8

echo
echo "════ 4. 基准对比：同模型同参数 ════"
echo "---- CUDA 后端（全部层放 GPU）----"
timeout 1200 ./llama-bench -m "$M" -ngl 99 -t 4 -p 128 -n 32 -r 2 2>&1 | tail -6
echo
echo "---- 对照：CPU 后端最优（10 线程）----"
cd $LLM/llama/bin
export LD_LIBRARY_PATH=$LLM/llama/bin:/usr/lib
timeout 900 ./llama-bench -m "$M" -t 10 -p 128 -n 32 -r 2 2>&1 | tail -4

echo
echo "════ 5. 负载后温度 / 内存 ════"
for z in /sys/class/thermal/thermal_zone*/; do
  t=$(cat $z/type 2>/dev/null); v=$(cat $z/temp 2>/dev/null)
  case "$t" in tj-therm|GPU-therm|CPU-therm) awk -v n="$t" -v x="$v" 'BEGIN{printf "  %-12s %.1fC\n", n, x/1000}' ;; esac
done
free -h | head -2
echo "-- GPU 侧可分配 --"
grep -oE '[0-9]+' /sys/kernel/debug/nvmap/iovmm/free_size | head -1 | awk '{printf "  %.2f GiB\n", $1/1073741824}'
