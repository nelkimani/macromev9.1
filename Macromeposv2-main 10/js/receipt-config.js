/* Macrome settings for receipt.js */
NotifyReceipt.config.shop={
  name:'MACROME ELECTRONICS',
  lines:['Furniture | Electronics | Household Goods','Chuka Town','Tel: 0715186441'],
  footer:['Thank you for shopping with us!','Furniture | Electronics | Household Goods']
};
NotifyReceipt.config.paperMm=58;   // P58E roll
NotifyReceipt.config.cols=32;      // 58mm = 32 characters per line
NotifyReceipt.config.bleChunk=20;  // safe Bluetooth write size; raise to 100 if your printer is fine with it
NotifyReceipt.config.cut=false;     // small 58mm printers have no cutter: just feed the paper (set true if yours cuts)
