<template>
  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h2>Tables</h2>
      <button @click="showForm = true" style="background:#e94560;color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;">+ Tambah</button>
    </div>
    <div v-if="showForm" style="background:rgba(255,255,255,0.05);padding:20px;border-radius:12px;margin-bottom:20px;">
      <input v-model="form.name" placeholder="Nama Meja (cth: Meja 1)" style="padding:10px;border:1px solid rgba(255,255,255,0.2);border-radius:8px;background:rgba(255,255,255,0.05);color:#fff;margin-bottom:10px;" />
      <div style="display:flex;gap:10px;">
        <button @click="saveTable" style="background:#4ade80;color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;">Simpan</button>
        <button @click="showForm=false" style="background:rgba(255,255,255,0.1);color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;">Batal</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:15px;">
      <div v-for="t in tables" :key="t.id" :style="{ background: 'rgba(255,255,255,0.05)', padding: '20px', borderRadius: '12px', borderLeft: '4px solid ' + tableColor(t.status) }">
        <div style="font-weight:600;font-size:1.1rem;">{{ t.name }}</div>
        <div :style="{ color: tableColor(t.status), fontSize: '0.85rem', marginTop: '5px' }">{{ t.status }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import axios from 'axios'

const tables = ref([])
const showForm = ref(false)
const form = ref({ name: '' })

const tableColor = (s) => ({ available: '#4ade80', occupied: '#e94560', reserved: '#fbbf24', maintenance: '#888' }[s] || '#888')

const loadTables = async () => {
  const token = localStorage.getItem('cafe_token')
  const res = await axios.get('/api/tables', { headers: { Authorization: `Bearer ${token}` } })
  tables.value = res.data
}

const saveTable = async () => {
  const token = localStorage.getItem('cafe_token')
  await axios.post('/api/tables', form.value, { headers: { Authorization: `Bearer ${token}` } })
  showForm.value = false
  form.value = {}
  loadTables()
}

onMounted(loadTables)
</script>
