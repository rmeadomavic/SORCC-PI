import serial

# Input the IP address for the sim card
ipAddy = input("Enter your IP address: ")

# Open the serial port

ser = serial.Serial('/dev/ttyUSB2', 115200, timeout=1)

# Send an AT command

command = "AT+CGDCONT=1,\"IP\",\"b2b.static\",\"{ipAddy}\",0,0\r\n" #AT command followed by carriage return
ser.write(command.encode())

# Read the response
response = ser.readline().decode().strip()

# Print the response
print(response)

# Close the serial port
ser.close()
