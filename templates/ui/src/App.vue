<template>
  <div style="min-height:100vh;background:#1a1a2e;color:#fff;">
    <nav style="background:linear-gradient(135deg,#e94560,#ff6b6b);padding:15px 20px;display:flex;justify-content:space-between;align-items:center;">
      <h2 style="margin:0;">☕ Cafe Azzura</h2>
      <div v-if="cart.length">
        <span style="background:#fff;color:#e94560;padding:5px 15px;border-radius:20px;font-weight:600;">{{ cart.length }} item</span>
      </div>
    </nav>
    
    <div style="max-width:800px;margin:0 auto;padding:20px;">
      <!-- Categories -->
      <div style="display:flex;gap:10px;overflow-x:auto;padding:10px 0;margin-bottom:20px;">
        <button v-for="c in categories" :key="c.id" 
          @click="selectedCategory = c.id"
          :style="{ background: selectedCategory === c.id ? '#e94560' : 'rgba(255,255,255,0.1)', border: 'none', padding: '8px 16px', borderRadius: '20px', color: '#fff', cursor: 'pointer' }">
          {{ c.name }}
        </button>
      </div>
      
      <!-- Products -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:15px;">
        <div v-for="p in filteredProducts" :key="p.id" 
          style="background:rgba(255,255,255,0.05);border-radius:12px;overflow:hidden;">
          <div style="height:120px;background:linear-gradient(135deg,#2a2a4e,#1a1a2e);display:flex;align-items:center;justify-content:center;font-size:3rem;">☕</div>
          <div style="padding:15px;">
            <div style="font-weight:600;">{{ p.name }}</div>
            <div style="color:#e94560;font-weight:600;margin:5px 0;">Rp {{ formatNumber(p.price) }}</div>
            <button @click="addToCart(p)" style="width:100%;padding:8px;background:#e94560;border:none;border-radius:6px;color:#fff;cursor:pointer;">+ Tambah</button>
          </div>
        </div>
      </div>
      
      <!-- Cart -->
      <div v-if="cart.length" style="position:fixed;bottom:0;left:0;right:0;background:linear-gradient(135deg,#e94560,#ff6b6b);padding:15px 20px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:600;">{{ cart.length }} item</div>
          <div style="font-size:1.2rem;font-weight:700;">Rp {{ formatNumber(cartTotal) }}</div>
        </div>
        <button @click="showCart = true" style="background:#fff;color:#e94560;border:none;padding:12px 30px;border-radius:25px;font-weight:600;cursor:pointer;">Pesan</button>
      </div>
      
      <!-- Cart Modal -->
      <div v-if="showCart" style="position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:100;">
        <div style="background:#1a1a2e;width:90%;max-width:500px;border-radius:16px;padding:20px;max-height:80vh;overflow-y:auto;">
          <h3 style="margin-bottom:15px;">Pesanan</h3>
          <div v-for="(item, i) in cart" :key="i" style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.1);">
            <div>{{ item.name }} x{{ item.qty }}</div>
            <div>Rp {{ formatNumber(item.price * item.qty) }}</div>
          </div>
          <div style="display:flex;justify-content:space-between;padding:15px 0;font-weight:700;font-size:1.2rem;border-top:2px solid #e94560;margin-top:10px;">
            <div>Total</div>
            <div>Rp {{ formatNumber(cartTotal) }}</div>
          </div>
          <button @click="placeOrder" style="width:100%;padding:14px;background:#4ade80;border:none;border-radius:8px;color:#fff;font-weight:600;cursor:pointer;margin-top:10px;">Bayar Sekarang</button>
          <button @click="showCart = false" style="width:100%;padding:12px;background:rgba(255,255,255,0.1);border:none;border-radius:8px;color:#fff;cursor:pointer;margin-top:10px;">Tutup</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'

const categories = ref([])
const products = ref([])
const selectedCategory = ref(null)
const cart = ref([])
const showCart = ref(false)

const filteredProducts = computed(() => {
  if (!selectedCategory.value) return products.value
  return products.value.filter(p => p.category_id === selectedCategory.value)
})

const cartTotal = computed(() => cart.value.reduce((sum, i) => sum + i.price * i.qty, 0))

const formatNumber = (n) => new Intl.NumberFormat('id-ID').format(n || 0)

const addToCart = (p) => {
  const existing = cart.value.find(c => c.id === p.id)
  if (existing) existing.qty++
  else cart.value.push({ ...p, qty: 1 })
}

const loadData = async () => {
  try {
    const token = localStorage.getItem('cafe_token')
    const [catRes, prodRes] = await Promise.all([
      axios.get('/api/categories', { headers: { Authorization: `Bearer ${token}` } }),
      axios.get('/api/products', { headers: { Authorization: `Bearer ${token}` } })
    ])
    categories.value = catRes.data
    products.value = prodRes.data
  } catch (e) { console.error(e) }
}

const placeOrder = async () => {
  try {
    const token = localStorage.getItem('cafe_token')
    await axios.post('/api/orders', {
      items: cart.value.map(c => ({ product_id: c.id, name: c.name, price: c.price, quantity: c.qty }))
    }, { headers: { Authorization: `Bearer ${token}` } })
    alert('Pesanan berhasil!')
    cart.value = []
    showCart.value = false
  } catch (e) { alert('Gagal: ' + e.message) }
}

onMounted(loadData)
</script>
