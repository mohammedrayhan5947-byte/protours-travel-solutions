const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js'

let loadPromise = null

/** Loads the Razorpay Checkout script once, reusing it on repeat calls. */
export function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve(true)
  if (loadPromise) return loadPromise

  loadPromise = new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = CHECKOUT_SRC
    script.onload = () => resolve(true)
    script.onerror = () => {
      loadPromise = null
      resolve(false)
    }
    document.body.appendChild(script)
  })

  return loadPromise
}
