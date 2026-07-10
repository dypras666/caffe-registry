<template>
  <div>
    <h2 style="margin-bottom:20px;">Dashboard</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;">
      <div style="background:rgba(255,255,255,0.05);padding:25px;border-radius:12px;text-align:center;">
        <div style="font-size:2.5rem;color:#e94560;">Rp {{ formatNumber(stats.revenue) }}</div>
        <div style="color:#a0a0a0;margin-top:8px;">Revenue Hari Ini</div>
      </div>
      <div style="background:rgba(255,255,255,0.05);padding:25px;border-radius:12px;text-align:center;">
        <div style="font-size:2.5rem;color:#4ade80;">{{ stats.todayOrders }}</div>
        <div style="color:#a0a0a0;margin-top:8px;">Order Hari Ini</div>
      </div>
      <div style="background:rgba(255,255,255,0.05);padding:25px;border-radius:12px;text-align:center;">
        <div style="font-size:2.5rem;color:#60a5fa;">{{ stats.totalTables }}</div>
        <div style="color:#a0a0a0;margin-top:8px;">Total Meja</div>
      </div>
      <div style="background:rgba(255,255,255,0.05);padding:25px;border-radius:12px;text-align:center;">
        <div style="font-size:2.5rem;color:#fbbf24;">{{ stats.totalProducts }}</div>
        <div style="color:#a0a0a0;margin-top:8px;">Total Produk</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import axios from 'axios'

const stats = ref({ revenue: 0, todayOrders: 0, totalTables: 0, totalProducts: 0 })

const formatNumber = (n) => new Intl.NumberFormat('id-ID').format(n || 0)

const loadStats = async () => {
  try {
    const token = localStorage.getItem('cafe_token')
    const res = await axios.get('/api/dashboard/stats', { headers: { Authorization: `Bearer ${token}` } })
    stats.value = res.data
  } catch (e) { console.error(e) }
}

onMounted(loadStats)
</script>
