<template>
  <div>
    <h2 style="margin-bottom:20px;">Orders</h2>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
          <th style="text-align:left;padding:12px;color:#a0a0a0;">Order #</th>
          <th style="text-align:left;padding:12px;color:#a0a0a0;">Table</th>
          <th style="text-align:left;padding:12px;color:#a0a0a0;">Status</th>
          <th style="text-align:left;padding:12px;color:#a0a0a0;">Total</th>
          <th style="text-align:left;padding:12px;color:#a0a0a0;">Waktu</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="o in orders" :key="o.id" style="border-bottom:1px solid rgba(255,255,255,0.05);">
          <td style="padding:12px;">{{ o.order_number }}</td>
          <td style="padding:12px;">{{ o.table_name || '-' }}</td>
          <td style="padding:12px;"><span :style="{ color: statusColor(o.status) }">{{ o.status }}</span></td>
          <td style="padding:12px;">Rp {{ formatNumber(o.total) }}</td>
          <td style="padding:12px;">{{ new Date(o.created_at).toLocaleString('id-ID') }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import axios from 'axios'

const orders = ref([])

const formatNumber = (n) => new Intl.NumberFormat('id-ID').format(n || 0)
const statusColor = (s) => ({ pending: '#fbbf24', preparing: '#60a5fa', ready: '#4ade80', paid: '#a78bfa' }[s] || '#fff')

const loadOrders = async () => {
  const token = localStorage.getItem('cafe_token')
  const res = await axios.get('/api/orders', { headers: { Authorization: `Bearer ${token}` } })
  orders.value = res.data
}

onMounted(loadOrders)
</script>
