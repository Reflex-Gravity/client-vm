<script setup lang="ts">
const count = ref(0);
const { data } = await useFetch('/api/hello');
</script>

<template>
  <main>
    <h1 id="title">Hello from Nuxt</h1>
    <p id="api">{{ data?.message }}</p>
    <button id="count" @click="count++">count is {{ count }}</button>
    <NuxtLink id="about-link" to="/about">About</NuxtLink>
  </main>
</template>
