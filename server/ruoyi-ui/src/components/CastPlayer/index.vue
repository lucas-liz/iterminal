<template>
  <div class="cast-player">
    <div class="cast-screen">
      <div ref="boxRef" class="cast-term" />
    </div>
    <div class="cast-controls">
      <el-button link :icon="playing ? 'VideoPause' : 'VideoPlay'" :disabled="!events.length" @click="toggle" />
      <span class="cast-time">{{ fmt(pos) }} / {{ fmt(timeline.total) }}</span>
      <el-slider v-model="sliderPos" class="cast-slider" :min="0" :max="Math.max(timeline.total, 0.001)" :step="0.1" :show-tooltip="false" :disabled="!events.length" @input="onSeek" />
      <el-radio-group v-model="speed" size="small">
        <el-radio-button :value="1">1x</el-radio-button>
        <el-radio-button :value="2">2x</el-radio-button>
        <el-radio-button :value="4">4x</el-radio-button>
        <el-radio-button :value="8">8x</el-radio-button>
      </el-radio-group>
      <el-checkbox v-model="skipIdle" class="cast-skip">跳过空闲</el-checkbox>
    </div>
  </div>
</template>

<script setup>
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

/**
 * asciicast v2 回放：第一行是头（width / height），之后每行 [秒, 类型, 数据]。
 * 类型 o 是终端输出，r 是尺寸变化（"列x行"），其它类型（i 输入等）忽略。
 */
const props = defineProps({
  cast: { type: String, default: "" }
})

/** 空闲超过这个时长（秒）时压缩成这个时长 */
const IDLE_CAP = 2

const boxRef = ref(null)
const playing = ref(false)
const speed = ref(1)
const skipIdle = ref(true)
const pos = ref(0)
const sliderPos = ref(0)
const header = ref({ width: 80, height: 24 })
const events = shallowRef([])
let term = null
let raf = 0
const state = { idx: 0, time: 0 }

const fmt = (sec) => {
  const s = Math.max(0, Math.floor(sec))
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0")
}

const timeline = computed(() => {
  const times = []
  let prev = 0
  let acc = 0
  for (const e of events.value) {
    const gap = Math.max(0, e[0] - prev)
    acc += skipIdle.value ? Math.min(gap, IDLE_CAP) : gap
    prev = e[0]
    times.push(acc)
  }
  return { times, total: acc }
})

function parse(text) {
  const lines = (text || "").split("\n")
  let h = { width: 80, height: 24 }
  const list = []
  lines.forEach((line, i) => {
    if (!line.trim()) return
    let v
    try {
      v = JSON.parse(line)
    } catch {
      return
    }
    if (i === 0 && !Array.isArray(v)) {
      h = { width: v.width || 80, height: v.height || 24 }
    } else if (Array.isArray(v) && v.length >= 3) {
      list.push(v)
    }
  })
  header.value = h
  events.value = list
}

function createTerm() {
  term?.dispose()
  term = new Terminal({
    cols: header.value.width,
    rows: header.value.height,
    fontSize: 13,
    fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
    theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
    disableStdin: true,
    scrollback: 5000,
    convertEol: false
  })
  term.open(boxRef.value)
  state.idx = 0
  state.time = 0
}

function advanceTo(t) {
  if (!term) return
  let out = ""
  const list = events.value
  const times = timeline.value.times
  while (state.idx < list.length && times[state.idx] <= t) {
    const [, kind, payload] = list[state.idx]
    if (kind === "o") {
      out += payload
    } else if (kind === "r") {
      if (out) {
        term.write(out)
        out = ""
      }
      const m = /^(\d+)x(\d+)$/.exec(payload)
      if (m) term.resize(Math.max(2, Number(m[1])), Math.max(1, Number(m[2])))
    }
    state.idx++
  }
  if (out) term.write(out)
  state.time = t
}

function stop() {
  cancelAnimationFrame(raf)
  raf = 0
  playing.value = false
}

function play() {
  if (!events.value.length) return
  if (state.time >= timeline.value.total) seek(0)
  playing.value = true
  let last = performance.now()
  const tick = (now) => {
    const dt = ((now - last) / 1000) * speed.value
    last = now
    const t = Math.min(timeline.value.total, state.time + dt)
    advanceTo(t)
    pos.value = t
    sliderPos.value = t
    if (t >= timeline.value.total) {
      stop()
      return
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}

function toggle() {
  playing.value ? stop() : play()
}

function seek(t) {
  if (!term) return
  if (t < state.time) {
    term.reset()
    term.resize(header.value.width, header.value.height)
    state.idx = 0
    state.time = 0
  }
  advanceTo(t)
  pos.value = t
}

function onSeek(v) {
  if (playing.value) {
    stop()
    seek(v)
    play()
  } else {
    seek(v)
  }
}

function load() {
  stop()
  parse(props.cast)
  createTerm()
  pos.value = 0
  sliderPos.value = 0
  play()
}

// 切换「跳过空闲」后时间轴变了：从头重放到同一个事件位置
watch(skipIdle, () => {
  const wasPlaying = playing.value
  stop()
  const idx = state.idx
  term?.reset()
  term?.resize(header.value.width, header.value.height)
  state.idx = 0
  state.time = 0
  const t = idx > 0 ? timeline.value.times[idx - 1] : 0
  advanceTo(t)
  pos.value = t
  sliderPos.value = t
  if (wasPlaying) play()
})

watch(() => props.cast, () => nextTick(load))
onMounted(() => nextTick(load))
onBeforeUnmount(() => {
  stop()
  term?.dispose()
  term = null
})
</script>

<style scoped>
.cast-screen {
  background: #1e1e1e;
  border-radius: 6px;
  padding: 8px;
  overflow: auto;
  max-height: 64vh;
}
.cast-term {
  display: inline-block;
}
.cast-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}
.cast-time {
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.cast-slider {
  flex: 1;
  min-width: 120px;
}
.cast-skip {
  margin-right: 0;
}
</style>
