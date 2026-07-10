<template>
  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h2>Products</h2>
      <button @click="showForm = true" style="background:#e94560;color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;">+ Tambah</button>
    </div>
    <div v-if="showForm" style="background:rgba(255,255,255,0.05);padding:20px;border-radius:12px;margin-bottom:20px;">
      <h3 style="margin-bottom:15px;">{{ editing ? 'Edit' : 'Tambah' }} Product</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:15px;">
        <input v-model="form.name" placeholder="Nama" style="padding:10px;border:1px solid rgba(255,255,255,0.2);border-radius:8px;background:rgba(255,255,255,0.05);color:#fff;" />
        <input v-model="form.price" type="number" placeholder="Harga" style="padding:10px;border:1px solid rgba(255,255,255,0.2);border-radius:8px;background:rgba(255,255,255,0.05);color:#fff;" />
      </div>
      <div style="margin-top:15px;display:flex;gap:10px;">
        <button @click="saveProduct" style="background:#4ade80;color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;">Simpan</button>
        <button @click="showForm=false;editing=null;form={}" style="background:rgba(255,255,255,0.1);color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;">Batal</button>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
          <th style="text-align:left;padding:12px;color:#a0a0a0;">Nama</th>
          <th style="text-align:left;padding:12px;color:#a0a0a0;">Harga</th>
          <th style="text-align:left;padding:12px;color:#a0a0a0;">Aksi</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in products" :key="p.id" style="border-bottom:1px solid rgba(255,255,255,0.05);">
          <td style="padding:12px;">{{ p.name }}</td>
          <td style="padding:12px;">Rp {{ formatNumber(p.price) }}</td>
          <td style="padding:12px;">
            <button @click="editProduct(p)" style="background:#fbbf24;color:#000;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;margin-right:5px;">Edit</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import axios from 'axios'

const products = ref([])
const showForm = ref(false)
const editing = ref(null)
const form = ref({ name: '', price: '' })

const formatNumber = (n) => new Intl.NumberFormat('id-ID').format(n || 0)

const loadProducts = async () => {
  const token = localStorage.getItem('cafe_token')
  const res = await axios.get('/api/products', { headers: { Authorization: `Bearer ${token}` } })
  products.value = res.data
}

const editProduct = (p) => {
  editing.value = p.id
  form.value = { name: p.name, price: p.price }
  showForm.value = true
}

const saveProduct = async () => {
  const token = localStorage.getItem('cafe_token')
  try {
    if (editing.value) {
      await axios.put(`/api/products/${editing.value}`, form.value, { headers: { Authorization: `Bearer ${token}` } })
    } else {
      await axios.post('/api/products', form.value, { headers: { Authorization: `Bearer ${token}` } })
    }
    showForm.value = false
    editing.value = null
    form.value = {}
    loadProducts()
  } catch (e) { console.error(e) }
}

onMounted(loadProducts)
</script>
